import { makeSessionStore, type SessionRow } from './sessionStore.js';

export type CheckinSessionRow = SessionRow;

const store = makeSessionStore('checkin_sessions');

export const getCheckinSession = store.get.bind(store);
export const openCheckinSession = store.open.bind(store);
export const startCheckinSession = store.start.bind(store);
export const completeCheckinSession = store.complete.bind(store);
export const findCheckinByAnswerTs = store.findByAnswerTs.bind(store);
export const abandonStaleCheckins = store.abandonStale.bind(store);
