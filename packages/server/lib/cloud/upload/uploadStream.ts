import crossFetch from 'cross-fetch'
import fetchCreator from 'fetch-retry-ts'
import type { ReadStream } from 'fs'
import { Readable } from 'stream'
import type { StreamActivityMonitor } from './StreamActivityMonitor'
import Debug from 'debug'

import { agent } from '@packages/network'

const debug = Debug('cypress:server:cloud:uploadStream')

export class HttpError extends Error {
  constructor (
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
  ) {
    super(`${status}: ${statusText}`)
  }
}

// expected to be passed into uploadStream: nock + delay is very difficult to
// use fake timers for, as the callback to generate a nock response (expectedly)
// executes before any retry is attempted, and there is no wait to "await" that
// retry hook to advance fake timers. If a method of using fake timers with nock
// is known, this can be refactored to simplify the uploadStream signature and
// bake the geometricRetry logic into the args passed to fetchCreator.
// without passing in a noop delay in the tests, or some way of advancing sinon's
// clock, the tests for uploadStream would take too long to execute.
export const geometricRetry = (n) => {
  return (n + 1) * 500
}

type UploadStreamOptions = {
  retryDelay?: (count: number) => number
  activityMonitor?: StreamActivityMonitor
}

const identity = (n: number) => n

export const uploadStream = async (fileStream: ReadStream, destinationUrl: string, fileSize: number, options?: UploadStreamOptions): Promise<void> => {
  const retryDelay = options?.retryDelay ?? identity
  const timeoutMonitor = options?.activityMonitor ?? undefined
  /**
   * To support more robust error messages from the server than statusText, we attempt to
   * retrieve response.json(). This is async, so a list of error promises is stored here
   * that must be resolved before throwing an aggregate error. This is necessary because
   * ts-fetch-retry's retryOn fn does not support returning a promise.
   */
  const errorPromises: Promise<Error>[] = []

  /**
   * these are retryable status codes. other status codes are not valid for automatic
   * retries.
   *   - 408 Request Timeout
   *   - 429 Too Many Requests (S3 can return this)
   *   - 502 Bad Gateway
   *   - 503 Service Unavailable
   *   - 504 Gateway Timeout
   * other http status codes are not valid for automatic retries.
   */
  const retryOnErrorCodes = [408, 429, 502, 503, 504]
  /**
   * In order to .pipeThrough the activity montior from the file stream to the fetch body,
   * the original file ReadStream must be converted to a ReadableStream, which is WHATWG spec.
   * Since ReadStream's data type isn't typed, .toWeb defaults to 'any', which causes issues
   * with node-fetch's `body` type definition. coercing this to ReadableStream<ArrayBufferView>
   * seems to work just fine.
   */
  const readableFileStream = Readable.toWeb(fileStream) as ReadableStream<ArrayBufferView>
  const abortController = timeoutMonitor?.getController()

  debug('PUT %s: %d byte file upload initiated', destinationUrl, fileSize)

  const retryableFetch = fetchCreator(crossFetch as typeof crossFetch, {
    retries: 2,
    retryDelay,

    retryOn: (attempt, retries, error, response) => {
      // Record all HTTP errors encountered
      if (response?.status && response?.status >= 400) {
        errorPromises.push(new Promise(async (resolve, reject) => {
          try {
            const statusText = await response.json().catch(() => {
              return response.statusText
            })

            resolve(new HttpError(response.status, statusText, destinationUrl))
          } catch (e) {
            resolve(e)
          }
        }))
      }

      // Record network errors
      if (error) {
        errorPromises.push(Promise.resolve(error))
      }

      const isUnderRetryLimit = attempt < retries
      const isNetworkError = !!error
      const isRetryableHttpError = (!!response?.status && retryOnErrorCodes.includes(response.status))

      debug('checking if should retry: %s %O', destinationUrl, {
        attempt,
        retries,
        networkError: error,
        status: response?.status,
        statusText: response?.statusText,
      })

      return (
        isUnderRetryLimit && // retries param is ignored if retryOn is a fn, so have to impl
        (isNetworkError || isRetryableHttpError)
      )
    },
  })

  return new Promise(async (resolve, reject) => {
    debug(`${destinationUrl}: PUT ${fileSize}`)

    readableFileStream

    try {
      const response = await retryableFetch(destinationUrl, {
        // ts thinks this is a browser fetch, but it is a node-fetch
        // @ts-ignore
        agent,
        method: 'PUT',
        headers: {
          'content-length': String(fileSize),
          'content-type': 'application/x-tar',
          'accept': 'application/json',
        },
        body: timeoutMonitor ? timeoutMonitor.monitor(readableFileStream) : readableFileStream,
        ...(abortController && { signal: abortController.signal }),
      })

      debug('PUT %s: HTTP %d %s', destinationUrl, response.status, response.statusText)

      if (response.status >= 400) {
        const errors = await Promise.all(errorPromises)

        reject(
          errors.length > 1 ?
            new AggregateError(errors, `${errors.length} errors encountered during upload`) :
            errors[0],
        )
      } else {
        // S3 does not include a response body - if the request succeeds,
        // a simple 200 response is returned
        resolve()
      }
    } catch (e) {
      const error = abortController?.signal.reason ?? e

      debug('PUT %s: %s', destinationUrl, error)
      reject(error)
    }
  })
}
