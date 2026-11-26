import type { pull as en } from "../en/pull";

export const pull: Record<keyof typeof en, string> = {
  "pull.why.pulled": "{branch}을(를) {remote}에 맞춰 최신으로 만들었습니다: 새 커밋 {n}개({from}에서 {to}로).",
  "pull.why.pulledOne": "{branch}을(를) {remote}에 맞춰 최신으로 만들었습니다: 새 커밋 1개({from}에서 {to}로).",
  "pull.why.current": "{branch}은(는) {remote}와 같이 최신입니다.",
  "pull.why.git_missing": "풀하지 않았습니다: git이 이 컴퓨터에 없습니다.",
  "pull.why.config": "풀하지 않았습니다: 이 프로젝트 자체의 git 설정이 git이 실행할 프로그램이나 다른 가져올 주소를 지정합니다({setting}). 앱은 그것을 스스로 실행하지 않아요. 믿을 수 있다면 터미널에서 풀하세요.",
  "pull.why.busy": "{branch}을(를) 풀하지 않았습니다: 이 폴더에서 git이 작업 중입니다.",
  "pull.why.detached": "풀하지 않았습니다: 이 폴더는 어떤 브랜치에도 있지 않습니다.",
  "pull.why.no_upstream": "{branch}을(를) 풀하지 않았습니다: 원격의 브랜치를 추적하지 않습니다.",
  "pull.why.not_default": "풀하지 않았습니다: 이 폴더는 원격의 기본 브랜치가 아닌 {branch}에 있습니다.",
  "pull.why.unread": "{branch}을(를) 풀하지 않았습니다: git이 폴더의 내용을 읽지 못했습니다.",
  "pull.why.changes": "{branch}을(를) 풀하지 않았습니다: 폴더에 바뀌었거나 새로 생긴 파일이 있습니다.",
  "pull.why.submodules": "{branch}을(를) 풀하지 않았습니다: 이 프로젝트에는 서브모듈이 있고, 앱은 그 안을 스스로 살펴보지 않습니다. 터미널에서 풀하세요.",
  "pull.why.ahead": "{branch}을(를) 풀하지 않았습니다: 아직 원격에 없는 커밋이 있습니다.",
  "pull.why.fetch_failed": "{branch}을(를) 풀하지 않았습니다: 비밀번호 없이 10초 안에 {remote}에 연결하지 못했습니다.",
  "pull.why.diverged": "{branch}을(를) 풀하지 않았습니다: 이쪽과 {remote}가 각각 앞서 있어 그대로 앞으로 옮길 수 없습니다.",
  "pull.why.failed": "{branch}을(를) 풀하지 않았습니다: git이 앞으로 옮기기를 거부했습니다.",
};
