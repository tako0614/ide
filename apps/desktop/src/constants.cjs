/**
 * アプリケーション全体で使用される定数定義
 */

const DEFAULT_PORT = Number(process.env.DECK_IDE_PORT || 8787);
const SERVER_URL_FALLBACK = `http://localhost:${DEFAULT_PORT}`;
const LOG_LINE_LIMIT = 400;

module.exports = {
  DEFAULT_PORT,
  SERVER_URL_FALLBACK,
  LOG_LINE_LIMIT
};
