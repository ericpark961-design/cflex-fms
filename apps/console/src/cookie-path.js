// cookie-path.js — 세션 쿠키의 Path 를 정한다.
//
// server.js 안에 두면 시험에서 부를 수 없고, 이 판정은 시험으로 고정해야
// 한다: 값 하나가 잘못 통과하면 쿠키 경로가 주입된다.
'use strict';

/** 한 경로 조각에 쓸 수 있는 글자. 세미콜론·공백·CR/LF·'..' 를 모두 막는다. */
const SAFE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/**
 * @param {string|undefined|null} forwardedPrefix  X-Forwarded-Prefix 헤더
 * @param {boolean} trustProxy
 * @returns {string} 쿠키 Path. 판단할 수 없으면 '/'
 */
function cookiePathFor(forwardedPrefix, trustProxy) {
  if (!trustProxy) return '/';
  const raw = String(forwardedPrefix || '');
  if (!SAFE.test(raw)) return '/';
  // '/../x' 는 SAFE 를 통과한다('..' 는 점 두 개로 허용 글자다) — 따로 막는다.
  if (raw.split('/').some((seg) => seg === '..' || seg === '.')) return '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

module.exports = { cookiePathFor, SAFE };
