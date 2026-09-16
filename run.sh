#!/usr/bin/env bash
#
# run.sh —— Unfold 本地驱动器：声明参数 → 切 node → 编译 → 运行
#
#   ./run.sh --dry-run --repo /path/to/workspace
#   REPO=/path/to/workspace DRY_RUN=1 ./run.sh
#
# 每个参数都有两种给法：命令行选项，或同名环境变量。命令行优先。
# 只想看章节怎么分就 --dry-run（什么都不落地）；满意了再去掉它真跑一次。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$ROOT/packages/core/dist/bin/unfold.js"

# ── 参数声明 ─────────────────────────────────────────────────────────
# `: "${X:=默认}"` 的含义：环境变量已经给了就用它，否则用默认值。
REPO_EXPLICIT=0
[ -n "${REPO:-}" ] && REPO_EXPLICIT=1

: "${ACTION:=narrate}"      # narrate | e2e —— 跑驱动器，还是跑 e2e 测试套件
: "${REPO:=$PWD}"           # 被叙事的目标工作区，必须是 git worktree
: "${BASE:=}"               # 显式 base revision；空 = 自动推导
: "${DEFAULT_BRANCH:=}"     # 推导 base 时用的默认分支；空 = CLI 默认 main
: "${RULES:=}"              # 叙事规则文件；空 = <repo>/.unfold/narrative.json → 内置四层
: "${COMPARE:=}"            # 与历史 plan 比较：latest | <review-id>；空 = 不比
: "${DRY_RUN:=0}"           # 1 = 只算 plan 并打印，不建分支/worktree，不留产物
: "${REUSE:=0}"             # 1 = 复用最近一次 review 的目录与分支，轮次递增
: "${OPEN:=0}"              # 1 = 跑完用 VS Code 打开叙事 worktree
: "${CLEAN:=0}"             # 1 = 清掉该仓库全部 review 目录/worktree/refs，然后退出
: "${BUILD:=1}"             # 0 = 跳过编译直接用现有 dist（改过 TS 就别跳）
: "${INSTALL:=auto}"        # auto = node_modules 缺失时才装；1 = 总是装；0 = 从不装

usage() {
  cat <<'USAGE'
usage: ./run.sh [选项]

  动作
    --e2e                    跑 e2e 测试套件而不是驱动器（给了 --repo 就连真实仓库那组一起跑）
    --clean                  清掉该仓库全部 review 目录/worktree/refs，然后退出

  目标与规则
    --repo <path>            被叙事的工作区，缺省当前目录
    --base <rev>             显式 base，缺省自动推导
    --default-branch <name>  推导 base 用的默认分支，缺省 main
    --rules <file>           叙事规则文件，缺省读 <repo>/.unfold/narrative.json，再缺省内置四层

  跑法
    --dry-run                只算 plan 并打印，什么都不落地
    --reuse                  复用最近一次 review 的目录与分支，轮次递增
    --compare <id|latest>    与某次历史 plan 并排比较章节划分
    --open                   跑完用 VS Code 打开叙事 worktree

  编译
    --no-build               跳过 pnpm -r build，直接用现有 dist
    --install                强制先 pnpm install

每个选项都有同名环境变量（REPO / BASE / DRY_RUN / REUSE / ...），命令行优先。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --e2e)            ACTION=e2e; shift ;;
    --repo)           REPO="${2:?--repo 需要一个路径}"; REPO_EXPLICIT=1; shift 2 ;;
    --base)           BASE="${2:?--base 需要一个 revision}"; shift 2 ;;
    --default-branch) DEFAULT_BRANCH="${2:?--default-branch 需要一个分支名}"; shift 2 ;;
    --rules)          RULES="${2:?--rules 需要一个文件路径}"; shift 2 ;;
    --compare)        COMPARE="${2:?--compare 需要 latest 或一个 review-id}"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --reuse)          REUSE=1; shift ;;
    --open)           OPEN=1; shift ;;
    --clean)          CLEAN=1; shift ;;
    --no-build)       BUILD=0; shift ;;
    --install)        INSTALL=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                echo "未知参数：$1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# ── node ────────────────────────────────────────────────────────────
# 本机默认 node 是 20，跑不了 vitest 5 / TS 7，所以这里按 .nvmrc 切一次。
# nvm.sh 内部引用未定义变量，`set -u` 下会直接炸，故临时关掉。
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  export NVM_DIR
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || { nvm install >/dev/null 2>&1 && nvm use >/dev/null 2>&1; } || true
  set -u
fi

command -v node >/dev/null 2>&1 || { echo "找不到 node。" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "node $(node -v) 太老（需要 >= 22.12，见 package.json engines）。" >&2
  echo "装一个：nvm install \$(cat '$ROOT/.nvmrc')" >&2
  exit 1
fi

command -v pnpm >/dev/null 2>&1 || { echo "找不到 pnpm。先跑：corepack enable" >&2; exit 1; }

# ── 依赖与编译 ───────────────────────────────────────────────────────
if [ "$INSTALL" = "1" ] || { [ "$INSTALL" = "auto" ] && [ ! -d "$ROOT/node_modules" ]; }; then
  echo "▸ pnpm install"
  pnpm install --frozen-lockfile
fi

if [ "$BUILD" = "1" ]; then
  echo "▸ pnpm -r build"
  pnpm -r build
fi

# ── 运行 ────────────────────────────────────────────────────────────
if [ "$ACTION" = "e2e" ]; then
  if [ "$REPO_EXPLICIT" = "1" ]; then
    # 真实仓库那组断言「工作区必须是脏的」，先在这里说清楚，别等它报错
    if [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
      echo "▸ $REPO 没有未提交改动，真实仓库那组会失败——指一个 agent 刚干完活的 worktree。" >&2
      exit 1
    fi
    export UNFOLD_E2E_REPO="$REPO"
    echo "▸ e2e（含真实仓库：$REPO）"
  else
    echo "▸ e2e（只跑临时仓库那组；要带上真实仓库就加 --repo <脏的 worktree>）"
  fi
  UNFOLD_E2E=1 exec pnpm exec vitest run packages/*/tests/e2e --passWithNoTests
fi

[ -f "$CLI" ] || { echo "$CLI 不存在——别用 --no-build，或先跑一次 pnpm -r build。" >&2; exit 1; }
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "$REPO 不是 git 仓库。" >&2; exit 1; }

ARGS=(narrate --repo "$REPO")
[ -n "$BASE" ]           && ARGS+=(--base "$BASE")
[ -n "$DEFAULT_BRANCH" ] && ARGS+=(--default-branch "$DEFAULT_BRANCH")
[ -n "$RULES" ]          && ARGS+=(--rules "$RULES")
[ -n "$COMPARE" ]        && ARGS+=(--compare "$COMPARE")
[ "$DRY_RUN" = "1" ]     && ARGS+=(--dry-run)
[ "$REUSE" = "1" ]       && ARGS+=(--reuse)
[ "$OPEN" = "1" ]        && ARGS+=(--open)
[ "$CLEAN" = "1" ]       && ARGS+=(--clean)

echo "▸ unfold ${ARGS[*]}"
echo
exec node "$CLI" "${ARGS[@]}"
