/**
 * Minimal MPEG-TS PAT/PMT parser and audio PID packet filter.
 *
 * Used by the /as-audio-pl and /as-audio proxy endpoints to expose
 * muxed MPEG-TS audio tracks as separate HLS audio rendition playlists,
 * enabling LG TV's native HLS player to show an audio language selector.
 */

export const TS_PACKET_SIZE = 188;
const SYNC = 0x47;

export interface AudioTrack {
  pid: number;
  pmtPid: number;
  language: string;
  name: string;
}

export interface ProbeResult {
  tracks: AudioTrack[];
  pmtPid: number;
}

const LANG_NAMES: Record<string, string> = {
  hin: "Hindi",
  eng: "English",
  jpn: "Japanese",
  tel: "Telugu",
  tam: "Tamil",
  kan: "Kannada",
  mal: "Malayalam",
  ben: "Bengali",
  mar: "Marathi",
  urd: "Urdu",
  chi: "Chinese",
  kor: "Korean",
  ara: "Arabic",
  fre: "French",
  spa: "Spanish",
  por: "Portuguese",
  ger: "German",
  ita: "Italian",
  rus: "Russian",
  dut: "Dutch",
};

const AUDIO_STREAM_TYPES = new Set([
  0x03, // ISO/IEC 11172-3 MPEG-1 Audio
  0x04, // ISO/IEC 13818-3 MPEG-2 Audio
  0x0f, // ISO/IEC 13818-7 AAC
  0x11, // ISO/IEC 14496-3 HE-AAC
  0x81, // AC-3 (Dolby Digital)
  0x82, // DTS
  0x83, // Dolby TrueHD
  0x84, // Dolby Digital Plus
  0x87, // Dolby Digital Plus (atsc)
]);

function adaptationPayloadStart(buf: Buffer, pktOff: number): number {
  const adaptCtrl = (buf[pktOff + 3]! >> 4) & 0x03;
  if (adaptCtrl === 0x01) return pktOff + 4;
  if (adaptCtrl === 0x02) return pktOff + TS_PACKET_SIZE; // adaptation only, no payload
  if (adaptCtrl === 0x03) return pktOff + 4 + 1 + buf[pktOff + 4]!;
  return pktOff + 4;
}

function hasPUSI(buf: Buffer, pktOff: number): boolean {
  return !!(buf[pktOff + 1]! & 0x40);
}

function readPid(buf: Buffer, pktOff: number): number {
  return ((buf[pktOff + 1]! & 0x1f) << 8) | buf[pktOff + 2]!;
}

function parsePAT(buf: Buffer, pktOff: number): number | null {
  try {
    const payStart = adaptationPayloadStart(buf, pktOff);
    if (payStart >= pktOff + TS_PACKET_SIZE) return null;

    let pos = payStart;
    if (hasPUSI(buf, pktOff)) pos += 1 + buf[pos]!;
    if (pos + 8 >= pktOff + TS_PACKET_SIZE) return null;

    if (buf[pos] !== 0x00) return null;
    const secLen = ((buf[pos + 1]! & 0x0f) << 8) | buf[pos + 2]!;
    const contentEnd = Math.min(pos + 3 + secLen - 4, pktOff + TS_PACKET_SIZE - 4);
    pos += 8;

    while (pos + 4 <= contentEnd) {
      const progNum = (buf[pos]! << 8) | buf[pos + 1]!;
      const pid = ((buf[pos + 2]! & 0x1f) << 8) | buf[pos + 3]!;
      if (progNum !== 0) return pid;
      pos += 4;
    }
  } catch { /* bounds error */ }
  return null;
}

function parsePMT(buf: Buffer, pktOff: number, pmtPid: number): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  try {
    const payStart = adaptationPayloadStart(buf, pktOff);
    if (payStart >= pktOff + TS_PACKET_SIZE) return tracks;

    let pos = payStart;
    if (hasPUSI(buf, pktOff)) pos += 1 + buf[pos]!;
    if (pos + 12 >= pktOff + TS_PACKET_SIZE) return tracks;

    if (buf[pos] !== 0x02) return tracks;
    const secLen = ((buf[pos + 1]! & 0x0f) << 8) | buf[pos + 2]!;
    const contentEnd = Math.min(pos + 3 + secLen - 4, pktOff + TS_PACKET_SIZE - 4);

    const progInfoLen = ((buf[pos + 10]! & 0x0f) << 8) | buf[pos + 11]!;
    pos += 12 + progInfoLen;

    while (pos + 5 <= contentEnd) {
      const streamType = buf[pos]!;
      const esPid = ((buf[pos + 1]! & 0x1f) << 8) | buf[pos + 2]!;
      const esInfoLen = ((buf[pos + 3]! & 0x0f) << 8) | buf[pos + 4]!;
      pos += 5;

      if (AUDIO_STREAM_TYPES.has(streamType)) {
        let lang = "";
        let dp = pos;
        while (dp + 2 <= pos + esInfoLen && dp + 2 <= pktOff + TS_PACKET_SIZE) {
          const tag = buf[dp]!;
          const dlen = buf[dp + 1]!;
          if (tag === 0x0a && dlen >= 3 && dp + 5 <= pktOff + TS_PACKET_SIZE) {
            lang = String.fromCharCode(buf[dp + 2]!, buf[dp + 3]!, buf[dp + 4]!)
              .toLowerCase()
              .replace(/[^a-z]/g, "");
          }
          dp += 2 + dlen;
        }
        const name = LANG_NAMES[lang] ?? (lang ? lang.toUpperCase() : `Audio ${tracks.length + 1}`);
        tracks.push({ pid: esPid, pmtPid, language: lang, name });
      }
      pos += esInfoLen;
    }
  } catch { /* bounds error */ }
  return tracks;
}

/**
 * Scan up to `maxPackets` TS packets in `buf` to find PAT and PMT,
 * then return all detected audio elementary streams.
 */
export function probeAudioTracks(buf: Buffer, maxPackets = 40): ProbeResult {
  const limit = Math.min(buf.length, maxPackets * TS_PACKET_SIZE);
  let pmtPid: number | null = null;

  for (let i = 0; i + TS_PACKET_SIZE <= limit; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    if (readPid(buf, i) === 0 && hasPUSI(buf, i)) {
      pmtPid = parsePAT(buf, i);
      if (pmtPid !== null) break;
    }
  }

  if (pmtPid === null) return { tracks: [], pmtPid: -1 };

  for (let i = 0; i + TS_PACKET_SIZE <= limit; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    if (readPid(buf, i) === pmtPid && hasPUSI(buf, i)) {
      const tracks = parsePMT(buf, i, pmtPid);
      if (tracks.length > 0) return { tracks, pmtPid };
    }
  }

  return { tracks: [], pmtPid };
}

// ─── CRC-32 (MPEG-TS polynomial 0x04C11DB7) ──────────────────────────────────

/**
 * Compute the MPEG-TS CRC-32 over buf[start .. start+len).
 * Polynomial 0x04C11DB7, initial 0xFFFFFFFF, no input/output reflection.
 * This is the standard CRC used in PAT/PMT/CAT section tables (ISO 13818-1).
 */
function crc32mpeg(buf: Buffer, start: number, len: number): number {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < start + len; i++) {
    const byte = buf[i]!;
    for (let j = 7; j >= 0; j--) {
      const bit = (byte >> j) & 1;
      const msb = (crc >>> 31) & 1;
      crc = ((crc << 1) >>> 0);
      if (msb !== bit) crc = (crc ^ 0x04C11DB7) >>> 0;
    }
  }
  return crc >>> 0;
}

// ─── PMT packet rewriter ──────────────────────────────────────────────────────

/**
 * Return a copy of a 188-byte PMT TS packet with stream-loop entries for all
 * audio PIDs except `keepAudioPid` removed.
 *
 * Why this matters for LG WebOS:
 *   filterVideoAndAudio drops the TS *packets* for dropped audio PIDs, but the
 *   PMT table still *declares* those PIDs.  LG TV's native HLS player is strict:
 *   it continuously polls for declared elementary streams and when it cannot find
 *   the Telugu/Tamil audio packets it expects, it flags the segment as malformed,
 *   which stalls the video decoder (video freezes) while the audio buffer plays
 *   out.  Android ExoPlayer is lenient and ignores missing PIDs.
 *
 *   Patching the PMT to only declare the kept audio PID makes the TS stream
 *   internally consistent and eliminates the freeze.
 */
function patchPmtPacket(
  pktIn: Buffer,
  keepAudioPid: number,
  allAudioPids: Set<number>,
): Buffer {
  if (allAudioPids.size <= 1) return pktIn; // nothing to remove

  const pkt = Buffer.from(pktIn); // work on a copy

  // ── Locate PMT section payload ──────────────────────────────────────────────
  const af = (pkt[3]! >> 4) & 0x03;
  if (af === 0x02) return pkt; // adaptation-only packet — no payload
  let payStart = 4;
  if (af === 0x03) payStart = 4 + 1 + (pkt[4] ?? 0); // skip adaptation field

  let pos = payStart;
  if (pkt[1]! & 0x40) pos += 1 + (pkt[pos] ?? 0); // skip pointer_field when PUSI

  if (pos + 12 > 188 || pkt[pos] !== 0x02) return pkt; // not a PMT table_id

  const sectionBase = pos; // byte offset of table_id
  const secLen = ((pkt[pos + 1]! & 0x0f) << 8) | pkt[pos + 2]!;
  if (pos + 3 + secLen > 188) return pkt; // section overflows packet — malformed

  const progInfoLen = ((pkt[pos + 10]! & 0x0f) << 8) | pkt[pos + 11]!;
  const streamLoopStart = pos + 12 + progInfoLen;
  const crcStart        = sectionBase + 3 + secLen - 4; // CRC is last 4 bytes

  if (streamLoopStart > crcStart) return pkt; // malformed — no room for stream loop

  // ── Parse stream loop, collect entries to keep ──────────────────────────────
  const keptEntries: Buffer[] = [];
  let sp = streamLoopStart;
  while (sp + 5 <= crcStart) {
    const ePid      = ((pkt[sp + 1]! & 0x1f) << 8) | pkt[sp + 2]!;
    const esInfoLen = ((pkt[sp + 3]! & 0x0f) << 8) | pkt[sp + 4]!;
    const entrySize = 5 + esInfoLen;
    if (sp + entrySize > crcStart) break; // malformed entry — stop

    const isDroppedAudio = allAudioPids.has(ePid) && ePid !== keepAudioPid;
    if (!isDroppedAudio) keptEntries.push(pkt.subarray(sp, sp + entrySize));
    sp += entrySize;
  }

  const newStreamLoop = Buffer.concat(keptEntries);

  // ── Rewrite section_length ──────────────────────────────────────────────────
  // section_length = fixed 9 bytes (prog_num…prog_info_len) + progInfoLen + stream loop + 4 CRC
  const newSecLen = 9 + progInfoLen + newStreamLoop.length + 4;
  pkt[pos + 1] = (pkt[pos + 1]! & 0xf0) | ((newSecLen >> 8) & 0x0f);
  pkt[pos + 2] =  newSecLen & 0xff;

  // ── Copy new stream loop in-place ───────────────────────────────────────────
  newStreamLoop.copy(pkt, streamLoopStart);
  const newCrcPos = streamLoopStart + newStreamLoop.length;

  // ── Recalculate CRC-32 ──────────────────────────────────────────────────────
  const crc = crc32mpeg(pkt, sectionBase, newCrcPos - sectionBase);
  pkt[newCrcPos]     = (crc >>> 24) & 0xff;
  pkt[newCrcPos + 1] = (crc >>> 16) & 0xff;
  pkt[newCrcPos + 2] = (crc >>>  8) & 0xff;
  pkt[newCrcPos + 3] =  crc & 0xff;

  // ── Stuff remaining bytes (after CRC) with 0xFF ─────────────────────────────
  pkt.fill(0xff, newCrcPos + 4, TS_PACKET_SIZE);

  return pkt;
}

/**
 * Filter an MPEG-TS buffer to keep video + one audio PID.
 *
 * Keeps:
 *   - PAT packets (PID 0)
 *   - PMT packets (pmtPid) — rewritten to only declare the kept audio PID
 *   - All non-audio PIDs (video, data, etc.)
 *   - Only the selected audioPid
 *
 * All OTHER audio PIDs are dropped so the player has no choice but to
 * play the selected language.  Used by /as-va to guarantee Hindi default
 * on players (LG TV) that ignore HLS DEFAULT= and play whatever audio PID
 * the TS stream presents first.
 *
 * The PMT is also patched (dropped PIDs removed, CRC recalculated) so that
 * LG TV's strict native HLS decoder does not flag missing declared PIDs as
 * a stream error and stall the video decoder.
 */
export function filterVideoAndAudio(
  buf: Buffer,
  audioPid: number,
  pmtPid: number,
): Buffer {
  // Pass 1: collect all audio PIDs declared in the PMT.
  const allAudioPids = new Set<number>();
  for (let i = 0; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    if (readPid(buf, i) === pmtPid && hasPUSI(buf, i)) {
      const tracks = parsePMT(buf, i, pmtPid);
      for (const t of tracks) allAudioPids.add(t.pid);
      break;
    }
  }

  // Pass 2: build output — drop dropped-audio packets; patch PMT entries.
  const chunks: Buffer[] = [];
  for (let i = 0; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    const pid = readPid(buf, i);
    const isOtherAudio = allAudioPids.has(pid) && pid !== audioPid;
    if (isOtherAudio) continue; // drop this packet entirely

    if (pid === pmtPid && hasPUSI(buf, i) && allAudioPids.size > 0) {
      // Patch the PMT so it only declares the kept audio PID (or no audio at
      // all when audioPid < 0, i.e. video-only mode).
      // LG TV's WebOS native player is strict: if the PMT declares PIDs that
      // are absent from the packet stream it stalls the video decoder even
      // though the audio buffer keeps playing — producing "video freeze, audio
      // OK" symptoms that don't reproduce on Android ExoPlayer.
      chunks.push(patchPmtPacket(buf.subarray(i, i + TS_PACKET_SIZE), audioPid, allAudioPids));
    } else {
      chunks.push(buf.subarray(i, i + TS_PACKET_SIZE));
    }
  }

  return chunks.length === 0 ? buf : Buffer.concat(chunks);
}

/**
 * Filter an MPEG-TS buffer to keep VIDEO + PAT + PMT only — no audio at all.
 *
 * This is the correct output for the main video variant in a multi-audio HLS
 * master that uses #EXT-X-MEDIA:TYPE=AUDIO rendition groups.  Per the HLS spec
 * the player uses the rendition stream for audio and the variant TS for video;
 * having audio also muxed into the variant TS causes LG TV WebOS's GStreamer
 * player to receive the same audio from two independent sources simultaneously.
 * The slight timing difference between the two delivery paths creates
 * audio/video drift that the WebOS player cannot recover from — the video
 * decoder stalls ("video freeze") while the audio buffer plays out.
 * Android ExoPlayer silently ignores the muxed audio when an AUDIO= rendition
 * group is active, so the bug only manifests on LG TV.
 *
 * Passing audioPid = -1 to filterVideoAndAudio safely drops every audio PID
 * because no valid TS PID is ever negative.  The PMT is also patched to remove
 * all audio stream-loop entries so the stream is fully self-consistent.
 */
export function filterVideoOnly(buf: Buffer, pmtPid: number): Buffer {
  return filterVideoAndAudio(buf, -1, pmtPid);
}

/**
 * Filter an MPEG-TS buffer to keep only:
 *   - PAT packets (PID 0) — program association table
 *   - PMT packets (pmtPid) — program map table
 *   - Packets for the selected audioPid
 *
 * All other PID packets are dropped. Continuity counters for the
 * kept PIDs remain intact because we keep ALL their packets.
 *
 * Returns a new Buffer containing only the kept packets.
 */
export function filterAudioPid(
  buf: Buffer,
  audioPid: number,
  pmtPid: number,
): Buffer {
  const chunks: Buffer[] = [];

  for (let i = 0; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC) continue;
    const pid = readPid(buf, i);
    if (pid === 0 || pid === pmtPid || pid === audioPid) {
      chunks.push(buf.subarray(i, i + TS_PACKET_SIZE));
    }
  }

  return chunks.length === 0 ? buf : Buffer.concat(chunks);
}
