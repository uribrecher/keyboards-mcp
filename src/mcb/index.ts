#!/usr/bin/env node
const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;
console.log(`MCB starting (socket: ${SOCKET_PATH})`);
console.log("Phase 1 MVP — server wiring lands in Task 6.");
