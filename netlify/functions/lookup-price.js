// netlify/functions/lookup-price.js
//
// 프론트엔드에서 fetch('/.netlify/functions/lookup-price?address=...') 로 호출
// 인증키는 Netlify 환경변수에서 읽어옴 (코드에 직접 넣지 않음)
// 브이월드는 공동주택/개별주택 API마다 별도 인증키를 발급하므로 두 개로 분리:
//   VWORLD_API_KEY_APART = 공동주택가격속성조회용 인증키(Decoding)
//   VWORLD_API_KEY_INDVD = 개별주택가격속성조회용 인증키(Decoding)
// Netlify 대시보드: Site settings > Environment variables 에 둘 다 등록 필요

const VWORLD_KEY_APART = process.env.VWORLD_API_KEY_APART;
const VWORLD_KEY_INDVD = process.env.VWORLD_API_KEY_INDVD;
const CURRENT_YEAR = 2026;
const PREV_YEAR = 2025;

exports.handler = async (event) => {
  const address = event.queryStringParameters && event.queryStringParameters.address;

  if (!address) {
    return json(400, { ok: false, reason: 'missing_address' });
  }
  if (!VWORLD_KEY_APART && !VWORLD_KEY_INDVD) {
    return json(500, { ok: false, reason: 'missing_api_key' });
  }

  try {
    // ── 1단계: 주소 → PNU 변환 ──────────────────────────────────
    // TODO: 이 부분 요청 형식이 아직 검증 전입니다. 브이월드 공식 문서
    // (검색 API 2.0 또는 지오코더+연속지적도 조합) 확인 후 채워넣어야 합니다.
    // 지금은 임시로 지오코더(좌표 변환)까지만 시도합니다.
    const pnu = await addressToPnu(address);
    if (!pnu) {
      return json(200, { ok: false, reason: 'pnu_not_found' });
    }

    // ── 2단계: PNU로 당해년도·전년도 공동주택 공시가격 조회 ──────────
    let result = await fetchApartPrice(pnu, CURRENT_YEAR);
    let prevResult = await fetchApartPrice(pnu, PREV_YEAR);
    let housingType = '공동주택';

    // ── 3단계: 공동주택에서 못 찾으면 개별(단독)주택 API로 폴백 ──────
    if (!result) {
      result = await fetchDetachedPrice(pnu, CURRENT_YEAR);
      prevResult = await fetchDetachedPrice(pnu, PREV_YEAR);
      housingType = '단독주택';
    }

    if (!result) {
      return json(200, { ok: false, reason: 'price_not_found' });
    }

    return json(200, {
      ok: true,
      price: result,
      prevPrice: prevResult || undefined,
      housingType,
    });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, reason: 'server_error' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// 주소 → PNU 변환 (행정안전부_실시간 주소정보 조회 검색API, juso.go.kr)
// PNU(19자리) = 행정구역코드admCd(10) + 산여부(1, 0→1/1→2 변환) + 지번본번lnbrMnnm(4) + 지번부번lnbrSlno(4)
// 공식 근거: 도로명주소 도움센터 Q&A + 실제 API 소스 샘플(business.juso.go.kr) 확인 완료
// JUSO_API_KEY는 브이월드 키와 별개 — data.go.kr에서 이 API 활용신청 후 발급된 승인키를
// Netlify 환경변수 JUSO_API_KEY로 등록
const JUSO_API_KEY = process.env.JUSO_API_KEY;
const JUSO_ENDPOINT = 'https://business.juso.go.kr/addrlink/addrLinkApi.do'; // 확인 완료 (JSONP 아닌 서버용 일반 버전)

async function addressToPnu(address) {
  if (!JUSO_API_KEY) return null;

  const url = `${JUSO_ENDPOINT}?confmKey=${JUSO_API_KEY}` +
    `&currentPage=1&countPerPage=1&keyword=${encodeURIComponent(address)}&resultType=json`;

  const res = await fetch(url);
  const data = await res.json();

  const juso = data && data.results && data.results.juso && data.results.juso[0];
  if (!juso) return null;

  const admCd = juso.admCd;                 // 행정구역코드 10자리
  const mtYnRaw = juso.mtYn;                 // '0'(일반) 또는 '1'(산)
  const mtYnPnu = mtYnRaw === '1' ? '2' : '1'; // PNU 규격: 일반=1, 산=2
  const mnnm = String(juso.lnbrMnnm || '0').padStart(4, '0'); // 지번본번
  const slno = String(juso.lnbrSlno || '0').padStart(4, '0'); // 지번부번

  if (!admCd) return null;
  return `${admCd}${mtYnPnu}${mnnm}${slno}`; // 19자리 PNU
}

// 공동주택가격속성조회: https://api.vworld.kr/ned/data/getApartHousingPriceAttr
// (조회 순서는 기존과 동일: 공동주택 먼저 → 못 찾으면 개별주택으로 폴백)
async function fetchApartPrice(pnu, year) {
  if (!VWORLD_KEY_APART) return null;
  const url = `https://api.vworld.kr/ned/data/getApartHousingPriceAttr` +
    `?pnu=${pnu}&stdrYear=${year}&format=json&key=${VWORLD_KEY_APART}`;
  const res = await fetch(url);
  const data = await res.json();
  return extractPrice(data, 'pblntfPc');
}

// 개별(단독)주택가격정보 API — 공동주택에서 못 찾았을 때만 호출됨
async function fetchDetachedPrice(pnu, year) {
  if (!VWORLD_KEY_INDVD) return null;
  const url = `https://api.vworld.kr/ned/data/getIndvdHousingPriceAttr` +
    `?pnu=${pnu}&stdrYear=${year}&format=json&key=${VWORLD_KEY_INDVD}`;
  const res = await fetch(url);
  const data = await res.json();
  return extractPrice(data, 'housePc');
}

// 응답 구조 확인 완료 (2026.08 캡처 기준):
// { response: { totalCount, fields: { field: [ { pnu, pblntfPc 또는 housePc, ... } ] } } }
// 공동주택 = pblntfPc, 개별(단독)주택 = housePc. totalCount가 0이면 결과 없음.
// totalCount=1일 때 field가 배열이 아니라 단일 객체로 올 수도 있어 방어적으로 처리.
function extractPrice(data, priceField = 'pblntfPc') {
  try {
    const res = data && data.response;
    if (!res || Number(res.totalCount) < 1) return null;
    let field = res.fields && res.fields.field;
    if (Array.isArray(field)) field = field[0];
    if (!field || field[priceField] == null) return null;
    const price = Number(field[priceField]);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}
