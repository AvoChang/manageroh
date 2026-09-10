import { makeSessionStore, type SessionRow } from './sessionStore.js';

export type MiddaySessionRow = SessionRow;

const store = makeSessionStore('midday_sessions');

export const getMiddaySession = store.get.bind(store);
export const openMiddaySession = store.open.bind(store);
export const startMiddaySession = store.start.bind(store);
export const completeMiddaySession = store.complete.bind(store);
export const findMiddayByAnswerTs = store.findByAnswerTs.bind(store);
export const abandonStaleMiddays = store.abandonStale.bind(store);
