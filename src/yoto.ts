import { readFile } from 'node:fs/promises'
import { sleep, status } from './util.ts'

const API_BASE = 'https://api.yotoplay.com'

export type TranscodedAudio = {
  sha256: string
  duration: number
  fileSize: number
  channels: string
  format: string
  metadataTitle?: string
}

export type YotoTrack = {
  key: string
  title: string
  trackUrl: string
  duration: number
  fileSize: number
  channels: string
  format: string
  type: 'audio'
  overlayLabel: string
  display?: { icon16x16: string }
}

export type YotoChapter = {
  key: string
  title: string
  overlayLabel: string
  tracks: YotoTrack[]
  display?: { icon16x16: string }
}

export type ContentPayload = {
  cardId?: string
  title: string
  content: { chapters: YotoChapter[] }
  metadata: {
    media: { duration: number; fileSize: number; readableFileSize: number }
    cover?: { imageL: string }
  }
}

export class YotoApiError extends Error {
  status: number
  body: string

  constructor(message: string, statusCode: number, body: string) {
    super(message)
    this.name = 'YotoApiError'
    this.status = statusCode
    this.body = body
  }
}

export class YotoClient {
  #getToken: () => Promise<string>

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.#getToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')

    const response = await fetch(`${API_BASE}${pathname}`, { ...init, headers })
    const text = await response.text()
    if (!response.ok) {
      throw new YotoApiError(
        `${init.method ?? 'GET'} ${pathname} failed (${response.status})`,
        response.status,
        text.slice(0, 600),
      )
    }
    return text ? JSON.parse(text) : null
  }

  async getAudioUploadUrl(): Promise<{ uploadUrl: string; uploadId: string }> {
    const body = (await this.#request('/media/transcode/audio/uploadUrl')) as {
      upload?: { uploadUrl?: string; uploadId?: string }
    }
    const uploadUrl = body?.upload?.uploadUrl
    const uploadId = body?.upload?.uploadId
    if (!uploadUrl || !uploadId) {
      throw new Error('Yoto did not return an upload URL and upload ID')
    }
    return { uploadUrl, uploadId }
  }

  /** The presigned URL is not on api.yotoplay.com and must not carry our bearer token. */
  async putAudio(uploadUrl: string, file: string): Promise<void> {
    const buffer = await readFile(file)
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: buffer,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new YotoApiError(`Audio upload failed (${response.status})`, response.status, text.slice(0, 600))
    }
  }

  /**
   * Yoto transcodes asynchronously; transcodedSha256 appearing means it is done.
   * The docs suggest 30 polls at 500ms, which is fine for songs but not for a
   * 40 minute audiobook chapter, so this backs off and waits much longer.
   */
  async waitForTranscode(uploadId: string, label: string, timeoutMs = 15 * 60_000): Promise<TranscodedAudio> {
    const deadline = Date.now() + timeoutMs
    let delay = 500

    while (Date.now() < deadline) {
      const body = (await this.#request(`/media/upload/${uploadId}/transcoded?loudnorm=false`)) as {
        transcode?: {
          transcodedSha256?: string
          transcodedInfo?: {
            duration?: number
            fileSize?: number
            channels?: string
            format?: string
            metadata?: { title?: string }
          }
        }
      }

      const sha256 = body?.transcode?.transcodedSha256
      if (sha256) {
        const meta = body.transcode?.transcodedInfo ?? {}
        return {
          sha256,
          duration: Math.round(meta.duration ?? 0),
          fileSize: meta.fileSize ?? 0,
          channels: meta.channels ?? 'stereo',
          format: meta.format ?? 'mp3',
          metadataTitle: meta.metadata?.title,
        }
      }

      status(`  transcoding ${label} ...`)
      await sleep(delay)
      delay = Math.min(delay * 1.5, 5_000)
    }

    throw new Error(`Timed out waiting for Yoto to transcode ${label}`)
  }

  /** Icons must be raw binary PNG, not multipart form-data. */
  async uploadIcon(png: Buffer): Promise<string> {
    const body = (await this.#request('/media/displayIcons/user/me/upload?autoConvert=true', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(png),
    })) as { displayIcon?: { mediaId?: string }; mediaId?: string }

    const mediaId = body?.displayIcon?.mediaId ?? body?.mediaId
    if (!mediaId) throw new Error('Yoto did not return a mediaId for the uploaded icon')
    return mediaId
  }

  /** Cover art must be raw binary JPEG/PNG, not multipart form-data. */
  async uploadCoverImage(image: Buffer, contentType: string): Promise<string> {
    const body = (await this.#request(
      '/media/coverImage/user/me/upload?autoconvert=true&coverType=default',
      {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(image),
      },
    )) as { coverImage?: { mediaUrl?: string } }

    const mediaUrl = body?.coverImage?.mediaUrl
    if (!mediaUrl) throw new Error('Yoto did not return a mediaUrl for the uploaded cover image')
    return mediaUrl
  }

  /** The MYO playlists already in this account's library. */
  async listMyoContent(): Promise<Array<{ cardId: string; title: string }>> {
    const body = (await this.#request('/content/mine')) as {
      cards?: Array<{ cardId?: string; title?: string }>
    }
    return (body?.cards ?? []).flatMap((card) =>
      card.cardId ? [{ cardId: card.cardId, title: card.title ?? '(untitled)' }] : [],
    )
  }

  /** POST /content creates a playlist, or updates it in place when cardId is set. */
  async createOrUpdateContent(payload: ContentPayload): Promise<string> {
    const body = (await this.#request('/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })) as { cardId?: string; card?: { cardId?: string } }

    const cardId = body?.cardId ?? body?.card?.cardId ?? payload.cardId
    if (!cardId) throw new Error('Yoto did not return a cardId')
    return cardId
  }
}
