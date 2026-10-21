/*
 * 랜딩페이지 설정 파일 (주소는 이 파일 한 곳에서만 바꿉니다)
 *
 * submitFormUrl : 신청 폼을 받는 Supabase 함수 주소. 비워 두면 폼에 "연결 준비 중"이 표시되고 아무것도 전송되지 않습니다.
 * publicKey     : 공개용(anon) 키. 브라우저에 있어도 되는 값입니다.
 *
 * 주의: service_role(secret) 키와 DB 비밀번호는 절대 이 파일에 넣지 마세요.
 */
window.APP_CONFIG = {
  submitFormUrl: "https://hrshyvfpyphgqszcuche.supabase.co/functions/v1/submit-form",
  publicKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhyc2h5dmZweXBoZ3FzemN1Y2hlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NTU3MjUsImV4cCI6MjEwODEzMTcyNX0.EOpjQUq05hDEYUSZ6HR-EQcrMU8ABbikSHFOUbfo8GU"
};
