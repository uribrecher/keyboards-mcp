/**
 * Roland DT1 (Data Set 1) and RQ1 (Data Request 1) SysEx protocol.
 *
 * Reusable across Roland keyboards that use the DT1/RQ1 protocol:
 * JUNO-X, JUPITER-X, FANTOM, etc. Only the model ID changes between keyboards.
 *
 * JUNO-X model ID: [0x00, 0x00, 0x00, 0x00, 0x12]
 * Default device ID: 0x10 (broadcast: 0x7F)
 */

// Internal constants
const SYSEX_START = 0xF0;
const SYSEX_END = 0xF7;
const ROLAND_ID = 0x41;
const CMD_RQ1 = 0x11;
const CMD_DT1 = 0x12;

export interface RolandModelId {
  bytes: number[];  // e.g. [0x00, 0x00, 0x00, 0x00, 0x12] for JUNO-X
}

export interface DT1Message {
  address: number[];  // 4 bytes
  data: number[];     // 1+ bytes
}

/**
 * Roland checksum: (128 - (sum of bytes % 128)) % 128
 * Input is address bytes + data bytes.
 */
export function rolandChecksum(bytes: number[]): number {
  const sum = bytes.reduce((acc, b) => acc + b, 0);
  return (128 - (sum % 128)) % 128;
}

/**
 * Split a value into 4-bit nibbles (high nibble first).
 * Example: value=0x1AB, byteCount=4 → [0x00, 0x01, 0x0A, 0x0B]
 */
export function packNibbles(value: number, byteCount: number): number[] {
  const result: number[] = new Array(byteCount).fill(0);
  for (let i = byteCount - 1; i >= 0; i--) {
    result[i] = value & 0x0F;
    value >>= 4;
  }
  return result;
}

/**
 * Reverse of packNibbles — combine nibble bytes into a single value.
 */
export function unpackNibbles(bytes: number[]): number {
  return bytes.reduce((acc, b) => (acc << 4) | (b & 0x0F), 0);
}

/**
 * Build a complete Roland DT1 SysEx message.
 * Format: F0 41 <dev> <modelId bytes> 12 <addr 4 bytes> <data bytes> <checksum> F7
 */
export function buildDT1(
  modelId: RolandModelId,
  deviceId: number,
  address: number[],
  data: number[]
): number[] {
  const checksumInput = [...address, ...data];
  const checksum = rolandChecksum(checksumInput);
  return [
    SYSEX_START,
    ROLAND_ID,
    deviceId,
    ...modelId.bytes,
    CMD_DT1,
    ...address,
    ...data,
    checksum,
    SYSEX_END,
  ];
}

/**
 * Build a complete Roland RQ1 SysEx message.
 * Format: F0 41 <dev> <modelId bytes> 11 <addr 4 bytes> <size 4 bytes> <checksum> F7
 */
export function buildRQ1(
  modelId: RolandModelId,
  deviceId: number,
  address: number[],
  size: number[]
): number[] {
  const checksumInput = [...address, ...size];
  const checksum = rolandChecksum(checksumInput);
  return [
    SYSEX_START,
    ROLAND_ID,
    deviceId,
    ...modelId.bytes,
    CMD_RQ1,
    ...address,
    ...size,
    checksum,
    SYSEX_END,
  ];
}

/**
 * Parse incoming SysEx bytes as a Roland DT1 message.
 * Returns address + data if valid DT1 for the given model, null otherwise.
 * Verifies: manufacturer=0x41, model ID match, command=0x12, checksum.
 */
export function parseDT1(sysex: number[], modelId: RolandModelId): DT1Message | null {
  // Minimum length: F0 41 <dev> <modelId> 12 <addr:4> <data:1> <checksum> F7
  const minLen = 1 + 1 + 1 + modelId.bytes.length + 1 + 4 + 1 + 1 + 1;
  if (sysex.length < minLen) return null;

  let i = 0;

  // F0
  if (sysex[i++] !== SYSEX_START) return null;

  // Manufacturer: Roland (0x41)
  if (sysex[i++] !== ROLAND_ID) return null;

  // Device ID (skip — any device ID is accepted)
  i++;

  // Model ID
  for (const b of modelId.bytes) {
    if (sysex[i++] !== b) return null;
  }

  // Command: DT1 (0x12)
  if (sysex[i++] !== CMD_DT1) return null;

  // Address (4 bytes)
  const address = sysex.slice(i, i + 4);
  i += 4;

  // Data (everything up to checksum and F7)
  const dataEnd = sysex.length - 2; // exclude checksum and F7
  if (dataEnd <= i) return null;
  const data = sysex.slice(i, dataEnd);
  i = dataEnd;

  // Checksum
  const receivedChecksum = sysex[i++];

  // F7
  if (sysex[i] !== SYSEX_END) return null;

  // Verify checksum
  const expectedChecksum = rolandChecksum([...address, ...data]);
  if (receivedChecksum !== expectedChecksum) return null;

  return { address, data };
}

/**
 * Add two 4-byte Roland addresses. Each byte wraps at 0x7F (& 0x7F).
 */
export function addAddresses(base: number[], offset: number[]): number[] {
  return base.map((b, i) => (b + (offset[i] ?? 0)) & 0x7F);
}
