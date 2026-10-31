/**
 * Minimal, dependency-free ZIP reader/writer.
 *
 * Only what this repository needs:
 * - `createZip(entries)` — deterministic (fixed timestamps, fixed order, deflate level 9),
 *   so re-running the build on the same sources produces a byte-identical ZIP with the
 *   same SHA-256.
 * - `readZipEntries(buffer)` — reads every entry, verifying CRC-32, so CI can prove that
 *   a published artifact really contains the manifest it claims to.
 *
 * Stores and deflates (method 0 and 8). Anything else throws instead of guessing.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** 1980-01-01T00:00:00Z in MS-DOS format: reproducible archives. */
const DOS_TIME = 0
const DOS_DATE = 0x0021

const FLAG_UTF8 = 0x0800
const VERSION_NEEDED = 20
const VERSION_MADE_BY = 0x031e // Unix, spec 3.0

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let index = 0; index < 256; index++) {
		let value = index
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		}
		table[index] = value >>> 0
	}
	return table
})()

/** CRC-32 (IEEE 802.3), as used by ZIP. */
export function crc32(buffer) {
	let crc = 0xffffffff
	for (let index = 0; index < buffer.length; index++) {
		crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

/**
 * Builds a ZIP archive.
 *
 * @param {{ name: string, data: Buffer }[]} entries Files to store, in the given order.
 * @returns {Buffer}
 */
export function createZip(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new Error('createZip: at least one entry is required')
	}

	const localParts = []
	const centralParts = []
	let offset = 0

	for (const entry of entries) {
		const name = normalizeName(entry.name)
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
		const nameBytes = Buffer.from(name, 'utf8')
		const crc = crc32(data)
		const deflated = deflateRawSync(data, { level: 9 })
		const useDeflate = deflated.length < data.length
		const payload = useDeflate ? deflated : data
		const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE

		const local = Buffer.alloc(30)
		local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
		local.writeUInt16LE(VERSION_NEEDED, 4)
		local.writeUInt16LE(FLAG_UTF8, 6)
		local.writeUInt16LE(method, 8)
		local.writeUInt16LE(DOS_TIME, 10)
		local.writeUInt16LE(DOS_DATE, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(payload.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		local.writeUInt16LE(0, 28)

		localParts.push(local, nameBytes, payload)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
		central.writeUInt16LE(VERSION_MADE_BY, 4)
		central.writeUInt16LE(VERSION_NEEDED, 6)
		central.writeUInt16LE(FLAG_UTF8, 8)
		central.writeUInt16LE(method, 10)
		central.writeUInt16LE(DOS_TIME, 12)
		central.writeUInt16LE(DOS_DATE, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(payload.length, 20)
		central.writeUInt32LE(data.length, 24)
		central.writeUInt16LE(nameBytes.length, 28)
		central.writeUInt16LE(0, 30) // extra length
		central.writeUInt16LE(0, 32) // comment length
		central.writeUInt16LE(0, 34) // disk number
		central.writeUInt16LE(0, 36) // internal attributes
		central.writeUInt32LE(0, 38) // external attributes
		central.writeUInt32LE(offset, 42)

		centralParts.push(central, nameBytes)

		offset += local.length + nameBytes.length + payload.length
	}

	const centralDirectory = Buffer.concat(centralParts)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(EOCD_SIG, 0)
	eocd.writeUInt16LE(0, 4)
	eocd.writeUInt16LE(0, 6)
	eocd.writeUInt16LE(entries.length, 8)
	eocd.writeUInt16LE(entries.length, 10)
	eocd.writeUInt32LE(centralDirectory.length, 12)
	eocd.writeUInt32LE(offset, 16)
	eocd.writeUInt16LE(0, 20)

	return Buffer.concat([...localParts, centralDirectory, eocd])
}

/**
 * Reads every entry of a ZIP archive, verifying the CRC-32 of each.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} Entry name (forward slashes, no leading slash) to bytes.
 */
export function readZipEntries(buffer) {
	const eocdOffset = findEocd(buffer)
	const entryCount = buffer.readUInt16LE(eocdOffset + 10)
	const centralOffset = buffer.readUInt32LE(eocdOffset + 16)

	if (entryCount === 0xffff || centralOffset === 0xffffffff) {
		throw new Error('readZipEntries: ZIP64 archives are not supported')
	}

	const entries = new Map()
	let cursor = centralOffset

	for (let index = 0; index < entryCount; index++) {
		if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
			throw new Error(`readZipEntries: bad central directory header at offset ${cursor}`)
		}

		const method = buffer.readUInt16LE(cursor + 10)
		const crc = buffer.readUInt32LE(cursor + 16)
		const compressedSize = buffer.readUInt32LE(cursor + 20)
		const uncompressedSize = buffer.readUInt32LE(cursor + 24)
		const nameLength = buffer.readUInt16LE(cursor + 28)
		const extraLength = buffer.readUInt16LE(cursor + 30)
		const commentLength = buffer.readUInt16LE(cursor + 32)
		const localOffset = buffer.readUInt32LE(cursor + 42)
		const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

		cursor += 46 + nameLength + extraLength + commentLength

		if (name.endsWith('/')) continue

		if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
			throw new Error(`readZipEntries: bad local header for '${name}'`)
		}

		const localNameLength = buffer.readUInt16LE(localOffset + 26)
		const localExtraLength = buffer.readUInt16LE(localOffset + 28)
		const dataStart = localOffset + 30 + localNameLength + localExtraLength
		const raw = buffer.subarray(dataStart, dataStart + compressedSize)

		let data
		if (method === METHOD_STORE) {
			data = Buffer.from(raw)
		} else if (method === METHOD_DEFLATE) {
			data = inflateRawSync(raw)
		} else {
			throw new Error(`readZipEntries: unsupported compression method ${method} for '${name}'`)
		}

		if (data.length !== uncompressedSize) {
			throw new Error(`readZipEntries: size mismatch for '${name}'`)
		}
		if (crc32(data) !== crc) {
			throw new Error(`readZipEntries: CRC mismatch for '${name}'`)
		}

		entries.set(name, data)
	}

	return entries
}

function findEocd(buffer) {
	const minimum = Math.max(0, buffer.length - 0xffff - 22)
	for (let offset = buffer.length - 22; offset >= minimum; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset
	}
	throw new Error('readZipEntries: end-of-central-directory record not found')
}

function normalizeName(name) {
	const normalized = String(name).replaceAll('\\', '/').replace(/^\/+/, '')
	if (!normalized || normalized.endsWith('/')) {
		throw new Error(`createZip: invalid entry name '${name}'`)
	}
	if (normalized.split('/').includes('..')) {
		throw new Error(`createZip: entry name escapes the archive: '${name}'`)
	}
	return normalized
}
