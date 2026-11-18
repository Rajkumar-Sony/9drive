import { Transform, type Readable } from 'node:stream'

export function countStreamBytes(source: Readable, maxBytes?: bigint, limitError: Error = new Error('Stream exceeded its allowed size.')) {
  let bytes = 0n
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const next = bytes + BigInt(chunk.length)
      if (maxBytes !== undefined && next > maxBytes) {
        source.unpipe(counter)
        // Continue draining this request without forwarding or buffering the rest of its body.
        source.resume()
        callback(limitError)
        return
      }
      bytes = next
      callback(null, chunk)
    },
  })
  source.on('error', (error) => counter.destroy(error))
  source.pipe(counter)
  return { stream: counter, bytes: () => bytes }
}
