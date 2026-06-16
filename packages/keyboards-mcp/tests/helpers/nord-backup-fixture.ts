/**
 * Synthetic Nord Electro 5D backup fixtures for unit tests.
 *
 * The real `.ne5b` format is a ZIP of CBIN-encoded files. These builders
 * produce byte-accurate CBIN buffers and assemble them into a `.ne5b` archive
 * on disk, so the parser exercises its real code paths without needing a real
 * (large, proprietary) backup file checked into the repo.
 */

import AdmZip from "adm-zip";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MidiConnection } from "../../src/shared/midi-connection.js";

const CBIN_MAGIC = 0x4e494243; // "CBIN" as LE uint32
const CBIN_HEADER_SIZE = 0x1c; // 28 bytes

/**
 * Inverse of the parser's MSB-first `readBits`: write `value` into `buf`
 * starting at absolute bit `absBit`, most-significant bit first.
 */
export function setBits(buf: Buffer, absBit: number, count: number, value: number): void {
  if (absBit < 0 || ((absBit + count - 1) >> 3) >= buf.length) {
    throw new RangeError(
      `setBits out of range: bits ${absBit}..${absBit + count - 1} exceed a ${buf.length}-byte buffer`,
    );
  }
  for (let i = 0; i < count; i++) {
    const bit = (value >> (count - 1 - i)) & 1;
    const bi = absBit + i;
    const by = bi >> 3;
    const bt = 7 - (bi & 7);
    if (bit) buf[by] |= 1 << bt;
    else buf[by] &= ~(1 << bt);
  }
}

export interface CbinHeaderFields {
  bankIndex?: number;
  slotIndex?: number;
  version?: number;
  typeTag?: string;
  typeDisc?: number;
  hash?: number;
}

/** Build a 28-byte CBIN header. */
export function makeCbinHeader(fields: CbinHeaderFields = {}): Buffer {
  const buf = Buffer.alloc(CBIN_HEADER_SIZE);
  buf.writeUInt32LE(CBIN_MAGIC, 0);
  buf.writeUInt32LE(fields.version ?? 1, 4);
  buf.write((fields.typeTag ?? "PROG").slice(0, 4).padEnd(4, "\0"), 8, "ascii");
  buf[0x0c] = fields.bankIndex ?? 0;
  buf[0x0e] = fields.slotIndex ?? 0;
  buf.writeUInt32LE(fields.typeDisc ?? 0, 0x14);
  buf.writeUInt32LE(fields.hash ?? 0, 0x18);
  return buf;
}

/** A field write into a program payload: [absBit, bitCount, value]. */
export type PayloadField = [number, number, number];

/**
 * Build a full `.ne5p` program file: 28-byte CBIN header + 140-byte payload
 * with the given bit-fields written (everything else zero).
 */
export function makeProgramFile(header: CbinHeaderFields, fields: PayloadField[]): Buffer {
  const payload = Buffer.alloc(140);
  for (const [bit, count, value] of fields) setBits(payload, bit, count, value);
  return Buffer.concat([makeCbinHeader(header), payload]);
}

/**
 * Build a `.ne5t` set-list file. Four 1-based program references are encoded
 * as 9-bit linear program numbers (`(bank-1)*50 + slot`) at payload bit 144.
 */
export function makeSetListFile(header: CbinHeaderFields, linearRefs: [number, number, number, number]): Buffer {
  const payload = Buffer.alloc(40);
  linearRefs.forEach((linear, r) => setBits(payload, 18 * 8 + r * 9, 9, linear));
  return Buffer.concat([makeCbinHeader(header), payload]);
}

/** Build a `.ne5l` live-preset file (only the header slot index is read). */
export function makeLivePresetFile(header: CbinHeaderFields): Buffer {
  return Buffer.concat([makeCbinHeader(header), Buffer.alloc(40)]);
}

export interface PianoNameOptions {
  /** Full CNSP name string, e.g. "Royal Grand 3D#Bright    Lrg". Omit for no `#`. */
  cnspName?: string;
  /** When false, omit the CNSP sub-header entirely (parser → "Unknown"). */
  withCnsp?: boolean;
}

/** Build a `.npno` piano file with a CNSP name sub-header. */
export function makePianoFile(header: CbinHeaderFields, opts: PianoNameOptions = {}): Buffer {
  const buf = Buffer.alloc(256);
  makeCbinHeader(header).copy(buf, 0);
  if (opts.withCnsp !== false) {
    const cnspOffset = 0x40;
    buf.write("CNSP", cnspOffset, "ascii");
    buf.write((opts.cnspName ?? "Generic Piano").slice(0, 79), cnspOffset + 0x18, "ascii");
  }
  return buf;
}

export interface SampleNameOptions {
  name?: string;
  suffix?: string;
  variant?: string;
  /** "cat" chunk key as "main:sub" (e.g. "8:0"); omit to leave out the chunk. */
  catKey?: string;
}

/** Build a `.nsmp` sample file with name/suffix/variant fields and a "cat" chunk. */
export function makeSampleFile(header: CbinHeaderFields, opts: SampleNameOptions = {}): Buffer {
  const buf = Buffer.alloc(256);
  makeCbinHeader(header).copy(buf, 0);
  buf.write((opts.name ?? "Sample").slice(0, 32), 0x4a, "ascii");
  if (opts.suffix) buf.write(opts.suffix.slice(0, 32), 0x6b, "ascii");
  if (opts.variant) buf.write(opts.variant.slice(0, 29), 0x8c, "ascii");
  if (opts.catKey) {
    const [main, sub] = opts.catKey.split(":").map((n) => Number(n));
    buf.write("cat", 0xad, "ascii");
    buf[0xad + 9] = main;
    buf[0xad + 10] = sub;
  }
  return buf;
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
}

/** Assemble entries into a `.ne5b` ZIP on disk; returns its path. */
export function buildNe5bZip(entries: ZipEntry[], fileName = "backup.ne5b"): string {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, typeof e.data === "string" ? Buffer.from(e.data, "utf-8") : e.data);
  }
  const dir = mkdtempSync(join(tmpdir(), "ne5b-fixture-"));
  const path = join(dir, fileName);
  writeFileSync(path, zip.toBuffer());
  return path;
}

/** Write raw bytes to a fresh temp file; returns its path. */
export function writeTempFile(data: Buffer | string, fileName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ne5b-tmp-"));
  const path = join(dir, fileName);
  writeFileSync(path, typeof data === "string" ? Buffer.from(data) : data);
  return path;
}

/** A MidiConnection that records every outgoing message — no real I/O. */
export class FakeMidiConnection implements MidiConnection {
  readonly cc: Array<{ controller: number; value: number; channel?: number }> = [];
  readonly programChanges: Array<{ program: number; channel?: number }> = [];
  readonly sysex: number[][] = [];
  readonly nrpn: Array<{ msb: number; lsb: number; value: number; channel?: number }> = [];
  readonly batches: Array<Array<{ controller: number; value: number; channel?: number }>> = [];

  sendCC(controller: number, value: number, channel?: number): void {
    this.cc.push({ controller, value, channel });
  }
  sendProgramChange(program: number, channel?: number): void {
    this.programChanges.push({ program, channel });
  }
  sendSysEx(bytes: number[]): void {
    this.sysex.push(bytes);
  }
  sendNRPN(msb: number, lsb: number, value: number, channel?: number): void {
    this.nrpn.push({ msb, lsb, value, channel });
  }
  async sendCCBatch(
    messages: Array<{ controller: number; value: number; channel?: number }>,
    _delayMs?: number,
  ): Promise<void> {
    this.batches.push(messages);
    for (const m of messages) this.cc.push(m);
  }
  onCC(_callback: (cc: number, value: number, channel: number) => void): void {
    /* no-op for tests */
  }
  onSysEx(_callback: (bytes: number[]) => void): () => void {
    return () => {
      /* unsubscribe no-op */
    };
  }
}
