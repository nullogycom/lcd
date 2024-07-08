import fetch, { HeadersInit } from 'node-fetch'
import { DEFAULT_HEADERS, SC_VERSION } from './constants.js'
import {
	ItemType,
	Streamer,
	SearchResults,
	GetByUrlResponse,
	GetStreamResponse
} from '../../types.js'
import {
	parseAlbum,
	parseTrack,
	parseArtist,
	parseHls,
	RawSearchResults,
	RawTrack,
	RawAlbum,
	RawArtist,
	ScClient
} from './parse.js'

function headers(oauthToken?: string | undefined): HeadersInit {
	const headers: HeadersInit = DEFAULT_HEADERS
	if (oauthToken) headers['Authorization'] = 'OAuth ' + oauthToken
	return headers
}

interface SoundcloudOptions {
	oauthToken?: string
}

interface SoundcloudTranscoding {
	url: string
	preset: string
	duration: number
	snipped: boolean
	format: {
		protocol: string
		mime_type: string
	}
	quality: string
}

export default class Soundcloud implements Streamer {
	hostnames = ['soundcloud.com', 'm.soundcloud.com', 'www.soundcloud.com']
	oauthToken?: string
	constructor(options: SoundcloudOptions) {
		this.oauthToken = options?.oauthToken
	}
	async search(query: string, limit = 20): Promise<SearchResults> {
		const client = await this.#getClient()
		const response = await fetch(
			this.#formatURL(
				`https://api-v2.soundcloud.com/search?q=${encodeURIComponent(
					query
				)}&offset=0&linked_partitioning=1&app_locale=en&limit=${limit}`,
				client
			),
			{ method: 'get', headers: headers(this.oauthToken) }
		)
		if (!response.ok) {
			const errMsg = await response.text()
			try {
				throw new Error(JSON.parse(errMsg))
			} catch (error) {
				if (errMsg) throw new Error(errMsg)
				else throw new Error('Soundcloud request failed. Try removing the OAuth token, if added.')
			}
		}

		const resultResponse = <RawSearchResults>await response.json()
		const items: SearchResults = {
			query,
			albums: [],
			tracks: [],
			artists: []
		}
		for (const i in resultResponse.collection) {
			if (resultResponse.collection[i].kind == 'track')
				items.tracks.push(await parseTrack(<RawTrack>resultResponse.collection[i]))
			else if (resultResponse.collection[i].kind == 'playlist')
				items.albums.push(await parseAlbum(<RawAlbum>resultResponse.collection[i]))
			else if (resultResponse.collection[i].kind == 'user')
				items.artists.push(parseArtist(<RawArtist>resultResponse.collection[i]))
		}

		return items
	}

	async #getClient(): Promise<ScClient> {
		const response = await (
			await fetch(`https://soundcloud.com/`, {
				method: 'get',
				headers: headers()
			})
		).text()

		const client = {
			version: SC_VERSION,
			anonId: response.split(`[{"hydratable":"anonymousId","data":"`)[1].split(`"`)[0],
			id: await fetchKey(response)
		}

		return client
	}

	async getTypeFromUrl(url: string): Promise<ItemType> {
		const { pathname } = new URL(url)
		if (pathname.split('/').slice(1).length == 1) return 'artist'
		else {
			if (pathname.split('/')?.[2] == 'sets') return 'album'
			else return 'track'
		}
	}

	async getByUrl(url: string): Promise<GetByUrlResponse> {
		return await this.#getMetadata(url)
	}

	#formatURL(og: string, client: ScClient): string {
		let url = og
		const parsed = new URL(og)

		if (!parsed.searchParams.get('user_id')) url = url + `&user_id=${client.anonId}`
		if (!parsed.searchParams.get('client_id')) url = url + `&client_id=${client.id}`
		if (!parsed.searchParams.get('app_version')) url = url + `&app_version=${client.version}`
		if (!parsed.searchParams.get('app_locale')) url = url + `&app_locale=en`

		return url
	}

	async #getMetadata(url: string): Promise<GetByUrlResponse> {
		// loosely based off: https://github.com/wukko/cobalt/blob/92c0e1d7b7df262fcd82ea7f5cf8c58c6d2ad744/src/modules/processing/services/soundcloud.js

		const type = await this.getTypeFromUrl(url)
		const client = await this.#getClient()

		// getting the IDs and track authorization
		const html = await (await fetch(url, { method: 'get', headers: headers() })).text()

		switch (type) {
			case 'track': {
				const trackId = html
					.split(`{"hydratable":"sound",`)?.[1]
					?.split(`"id":`)?.[1]
					?.split(',')?.[0]

				const api = JSON.parse(
					await (
						await fetch(
							this.#formatURL(`https://api-v2.soundcloud.com/tracks?ids=${trackId}`, client),
							{ method: 'get', headers: headers(this.oauthToken) }
						)
					).text()
				)[0]

				return {
					type: 'track',
					getStream: async (hq?: boolean) => {
						if (!hq) hq = false
						return await getStream(
							hq,
							api.media.transcodings,
							api.track_authorization,
							client,
							this.oauthToken
						)
					},
					metadata: await parseTrack(api)
				}
			}
			case 'album': {
				const data = JSON.parse(html.split(`"hydratable":"playlist","data":`)[1].split(`}];`)[0])
				const parsed: GetByUrlResponse = {
					type: 'album',
					metadata: await parseAlbum(data),
					tracks: await Promise.all(
						data.tracks.map(async (track: RawTrack) => {
							if (!track.title) track = await this.#getRawTrackInfo(track.id, client)
							track.user = data.user
							return parseTrack(track)
						})
					)
				}

				for (const i in data.tracks) {
					const track = data.tracks[i]

					const parsedTrack = {
						type: 'track',
						id: track.id,
						title: track.title,
						url: track.permalink_url,
						artists: [
							{
								id: data.user.id,
								name: data.user.username,
								url: data.user.permalink_url,
								pictures: [data.user.avatar_url.replace('-large', '-original')]
							}
						],
						durationMs: track.media?.transcodings?.[0]?.duration,
						coverArtwork: track.artwork_url?.replace('-large', '-original')
					}
					parsed.tracks.push(parsedTrack)
				}

				return parsed
			}
			case 'artist': {
				const data = JSON.parse(html.split(`{"hydratable":"user","data":`)[1].split(`}];`)[0])

				return {
					type: 'artist',
					metadata: parseArtist(data)
				}
			}
		}
	}
	async #getRawTrackInfo(id: number | string, client: ScClient) {
		const api = JSON.parse(
			await (
				await fetch(this.#formatURL(`https://api-v2.soundcloud.com/tracks?ids=${id}`, client), {
					method: 'get',
					headers: headers(this.oauthToken)
				})
			).text()
		)[0]

		return api
	}
}

async function fetchKey(response: string) {
	// loosely based on https://gitlab.com/sylviiu/soundcloud-key-fetch/-/blob/master/index.js

	const keys = response.split(`<script crossorigin src="`)
	let streamKey

	for (const i in keys) {
		if (typeof streamKey == 'string') continue

		const key = keys[i].split(`"`)[0]
		const keyregex =
			/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/
		if (!keyregex.test(key)) continue

		const script = await (await fetch(key)).text()
		if (script.split(`,client_id:"`).length > 1 && !streamKey) {
			streamKey = script.split(`,client_id:"`)?.[1]?.split(`"`)?.[0]
		} else continue
	}

	return streamKey
}

async function getStream(
	hq: boolean,
	transcodings: Array<SoundcloudTranscoding>,
	trackAuth: string,
	client: ScClient,
	oauthToken?: string | undefined
): Promise<GetStreamResponse> {
	let filter = transcodings.filter((x) => x.quality == 'hq')
	if (hq == true && filter.length == 0) throw new Error('Could not find HQ format.')
	
	if (filter.length == 0) filter = transcodings.filter((x) => x.preset.startsWith('aac_')) 	// prioritize aac (go+)
	if (filter.length == 0) filter = transcodings.filter((x) => x.preset.startsWith('opus_')) // then opus
	if (filter.length == 0) filter = transcodings.filter((x) => x.preset.startsWith('mp3_')) 	// then mp3
	if (filter.length == 0) throw new Error('Could not find applicable format.')							// and this is just in case none of those exist

	const transcoding = filter[0]
	const streamUrlResp = await fetch(
		`${transcoding.url}?client_id=${client.id}&track_authorization=${trackAuth}`,
		{
			headers: headers(oauthToken)
		}
	)
	const json = <{ url: string }>await streamUrlResp.json()
	if (!json.url) throw new Error('Stream URL could not be retreieved.')

	if (transcoding.format.protocol == 'progressive') {
		const streamResp = await fetch(json.url)
		return {
			mimeType: transcoding.format.mime_type,
			sizeBytes: parseInt(<string>streamResp.headers.get('Content-Length')),
			stream: <NodeJS.ReadableStream>streamResp.body
		}
	} else {
		const container = transcoding.format.mime_type.split('/')[1].split(';')[0].split('+')[0]

		return {
			mimeType: transcoding.format.mime_type,
			stream: (await parseHls(json.url, container))
		}
	}
}
