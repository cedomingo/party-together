// ---------------------------------------------------------------------------
// Platform core: room + lobby logic.
// ---------------------------------------------------------------------------
// This module must stay 100% game-agnostic. Nothing in here should ever
// import from /games/**. Game modules depend on this layer, never the
// reverse.
//
// Responsibilities that will live here (Phase 1+):
//   - createRoom(gameId, hostNickname)   → generates short room code, inserts
//                                            into `rooms`, seeds host as first player
//   - joinRoom(code, nickname)           → inserts into `players`, validates
//                                            room status/capacity
//   - leaveRoom / markDisconnected       → presence + grace-period handling
//   - transferHost                       → if host disconnects permanently
//   - lockRoom / startGame               → flips room.status, hands off to
//                                            the registered game's start hook
//   - cleanupExpiredRooms                → called by the cron route handler
//
// Intentionally empty in Phase 0 — scaffolding only.
export {};
