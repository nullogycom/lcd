import crypto from 'crypto'
import fetch from 'node-fetch'
import {
	ItemType,
	StreamerWithLogin,
	SearchResults,
	GetByUrlResponse,
	GetStreamResponse,
	Track
} from '../../types.js'
import { DEFAULT_HEADERS } from './constants.js'
import { parseAlbum, parseTrack, parseArtist, RawAlbum, RawArtist, RawTrack } from './parse.js'

function headers(token?: string): HeadersInit {
	const headers: HeadersInit = DEFAULT_HEADERS
	if (token) headers['X-User-Auth-Token'] = token
	return headers
}

function md5(str: string): string {
	return crypto.createHash('md5').update(str).digest('hex')
}

interface QobuzOptions {
	appSecret: string
	appId: string
	token?: string
}

export default class Qobuz implements StreamerWithLogin {
	hostnames = ['play.qobuz.com', 'open.qobuz.com', 'www.qobuz.com', 'qobuz.com']
	token?: string
	appSecret: string
	appId: string
	fetch?(url: URL | RequestInfo, init?: RequestInit): Promise<Response>
	constructor(options: QobuzOptions) {
		this.appSecret = options.appSecret
		this.appId = options.appId
		if (options.token) this.token = options.token
	}

	async #get(url: string, params: { [key: string]: string | number }) {
		for (const key in params) {
			if (typeof params[key] == 'number') params[key] = params[key].toString()
		}
		const response = await fetch(
			`https://www.qobuz.com/api.json/0.2/${url}?${new URLSearchParams(
				<{ [key: string]: string }>params
			)}`,
			{
				method: 'get',
				headers: headers(this.token)
			}
		)
		if (!response.ok) {
			const errMsg = await response.text()
			try {
				console.error('Qobuz error response:', JSON.parse(errMsg))
			} catch (error) {
				console.error('Qobuz error response:', errMsg)
			}
			throw new Error(`Fetching ${url} from Qobuz failed with status code ${response.status}.`)
		}
		return await response.json()
	}

	#createSignature(path: string, params: { [key: string]: string | number }) {
		if (!this.appSecret) throw new Error('appSecret not specified')

		const timestamp = Math.floor(Date.now() / 1000)
		let toHash = path.replace(/\//g, '')

		for (const key of Object.keys(params).sort()) {
			if (key != 'app_id' && key != 'user_auth_token') {
				toHash += key + params[key]
			}
		}

		toHash += timestamp + this.appSecret
		return {
			timestamp,
			hash: md5(toHash)
		}
	}

	async #getSigned(url: string, params: { [key: string]: string | number }) {
		const signature = this.#createSignature(url, params)
		params.request_ts = signature.timestamp.toString()
		params.request_sig = signature.hash
		return await this.#get(url, params)
	}

	async login(username: string, password: string) {
		if (this.token) return
		const params: { [key: string]: string } = {
			username,
			password: md5(password),
			extra: 'partner',
			app_id: this.appId
		}

		interface LoginResponse {
			user_auth_token: string
		}
		const loginResponse = <LoginResponse>await this.#getSigned('user/login', params)
		this.token = loginResponse.user_auth_token
	}

	async search(query: string, limit = 10): Promise<SearchResults> {
		if (!this.token) throw new Error('Not logged in.')

		interface RawSearchResults {
			query: string
			albums: { items: RawAlbum[] }
			tracks: { items: RawTrack[] }
			artists: { items: RawArtist[] }
		}
		const resultResponse = <RawSearchResults>(
			await this.#get('catalog/search', { query, limit, app_id: this.appId })
		)
		return {
			query: resultResponse.query,
			albums: resultResponse.albums.items.map(parseAlbum),
			tracks: resultResponse.tracks.items.map(parseTrack),
			artists: resultResponse.artists.items.map(parseArtist)
		}
	}

	async #getFileUrl(trackId: string, qualityId = 27): Promise<GetStreamResponse> {
		if (!this.token) throw new Error('Not logged in.')

		const params: { [key: string]: string } = {
			track_id: trackId.toString(),
			format_id: qualityId.toString(),
			intent: 'stream',
			sample: 'false',
			app_id: this.appId,
			user_auth_token: this.token
		}
		interface RawTrackFileResponse {
			url: string
			mime_type: string,
			sample: boolean
		}
		const trackFileResponse = <RawTrackFileResponse>(
			await this.#getSigned('track/getFileUrl', params)
		)
		if (trackFileResponse.sample == true) throw new Error('Could not get non-sample file. Check your token.')
		const streamResponse = await fetch(trackFileResponse.url)
		return {
			mimeType: trackFileResponse.mime_type,
			sizeBytes: parseInt(<string>streamResponse.headers.get('Content-Length')),
			stream: <NodeJS.ReadableStream>streamResponse.body
		}
	}

	async #getTrackMetadata(trackId: string) {
		return parseTrack(
			<RawTrack>await this.#get('track/get', {
				track_id: trackId,
				app_id: this.appId
			})
		)
	}

	async #getAlbum(albumId: string) {
		const albumResponse = <RawAlbum>await this.#get('album/get', {
			album_id: albumId,
			extra: 'albumsFromSameArtist,focusAll',
			app_id: this.appId
		})
		return {
			metadata: parseAlbum(albumResponse),
			tracks: albumResponse.tracks?.items.map(parseTrack)
		}
	}

	async #getArtistMetadata(artistId: string) {
		return parseArtist(
			<RawArtist>await this.#get('artist/get', {
				artist_id: artistId,
				extra: 'albums,playlists,tracks_appears_on,albums_with_last_release,focusAll',
				limit: 100,
				offset: 0,
				app_id: this.appId
			})
		)
	}

	#getUrlParts(url: string): ['artist' | 'album' | 'track', string] {
		const urlObj = new URL(url)
		if (urlObj.hostname == 'www.qobuz.com' || urlObj.hostname == 'qobuz.com') {
			const urlParts = url
				.match(/^https?:\/\/(?:www\.)?qobuz\.com\/[a-z]{2}-[a-z]{2}\/(.*?)\/.*?\/(.*?)$/)
				?.slice(1, 3)
			if (!urlParts) throw new Error('URL not supported')
			urlParts[1] = urlParts[1].replace(/\?.*?$/, '')
			const [type, id] = urlParts
			switch (type) {
				case 'interpreter':
					return ['artist', id]
				case 'album':
				case 'track':
					return [type, id]
				default:
					throw new Error('URL unrecognised')
			}
		}
		const urlParts = url
			.match(/^https:\/\/(?:play|open)\.qobuz\.com\/(.*?)\/([^/]*?)\/?$/)
			?.slice(1, 3)
		if (!urlParts) throw new Error('URL not supported')
		urlParts[1] = urlParts[1].replace(/\?.*?$/, '')
		if (urlParts[0] != 'artist' && urlParts[0] != 'album' && urlParts[0] != 'track') {
			throw new Error('URL unrecognised')
		}
		return [urlParts[0], urlParts[1]]
	}
	async getTypeFromUrl(url: string): Promise<ItemType> {
		return this.#getUrlParts(url)[0]
	}
	async getByUrl(url: string): Promise<GetByUrlResponse> {
		const [type, id] = this.#getUrlParts(url)
		switch (type) {
			case 'track': {
				return {
					type,
					getStream: () => {
						return this.#getFileUrl(id)
					},
					metadata: await this.#getTrackMetadata(id)
				}
			}
			case 'album': {
				const album = await this.#getAlbum(id)
				return {
					type,
					tracks: <Track[]>album.tracks,
					metadata: album.metadata
				}
			}
			case 'artist': {
				return {
					type,
					metadata: await this.#getArtistMetadata(id)
				}
			}
			default:
				throw new Error('URL unrecognised')
		}
	}
}
