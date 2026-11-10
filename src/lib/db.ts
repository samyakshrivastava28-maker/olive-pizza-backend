import { pgPool, query as pgQuery } from '../config/postgres.js';

let activeQuery = pgQuery;
let activePool: any = pgPool;

export const query: typeof pgQuery = (text: any, params?: any) => {
  return activeQuery(text, params);
};

export const pool = {
  query: (text: any, params?: any) => activeQuery(text, params),
  connect: () => activePool.connect(),
};

export const getClient = () => {
  return activePool.connect();
};

export const setTestDbOverride = (overrideQuery?: any, overridePool?: any) => {
  activeQuery = overrideQuery || pgQuery;
  activePool = overridePool || pgPool;
};

export default pgPool;
