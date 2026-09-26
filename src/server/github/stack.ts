// GET /api/prs/:o/:r/:n/stack — SPIKE. The PR's stack, found by walking the
// base/head branch chain (base of one == head of the one below), plus the
// combined diff of the whole stack from the compare API. Read-only.
import { normalizeFile } from "../../shared/gh/normalize";
import { prIdOf, type PrRef } from "../../shared/gh/prKey";
import type { PrStack, StackPr } from "../../shared/gh/stack";
import type { RestPullFile } from "../../shared/gh/wire";
import type { Config } from "../config/store";
import { graphql, rest } from "./client";

const MAX_DEPTH = 8;

export async function fetchPrStack(
  cfg: Config,
  ref: PrRef,
  signal?: AbortSignal,
): Promise<PrStack> {
  const self = await query(
    cfg,
    ref,
    `pullRequest(number: ${ref.number}) { ...P }`,
    signal,
  );
  const start = self.repository?.pullRequest;
  if (!start) return { prs: [], combined: [] };

  const prs: StackPr[] = [toStackPr(ref, start)];
  // Down: an open PR whose HEAD is this one's base.
  for (let i = 0; i < MAX_DEPTH; i++) {
    const below = await firstOpen(
      cfg,
      ref,
      "headRefName",
      prs[0].baseRef,
      signal,
    );
    if (!below) break;
    prs.unshift(toStackPr(ref, below));
  }
  // Up: an open PR BASED on this one's head. A fork in the stack takes the first.
  for (let i = 0; i < MAX_DEPTH; i++) {
    const above = await firstOpen(
      cfg,
      ref,
      "baseRefName",
      prs[prs.length - 1].headRef,
      signal,
    );
    if (!above) break;
    prs.push(toStackPr(ref, above));
  }
  if (prs.length < 2) return { prs, combined: [] };

  // Three-dot compare = merge-base diff, the same thing a PR's own diff is.
  const bottom = prs[0];
  const top = prs[prs.length - 1];
  const { data } = await rest<{ files?: RestPullFile[] }>(
    cfg.github,
    `/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(bottom.baseRef)}...${top.headSha}`,
    { signal },
  );
  return { prs, combined: (data.files ?? []).map(normalizeFile) };
}

type Node = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
};

async function firstOpen(
  cfg: Config,
  ref: PrRef,
  field: "headRefName" | "baseRefName",
  branch: string,
  signal?: AbortSignal,
): Promise<Node | null> {
  const res = await query(
    cfg,
    ref,
    `pullRequests(${field}: ${JSON.stringify(branch)}, states: OPEN, first: 5) { nodes { ...P } }`,
    signal,
  );
  return (
    res.repository?.pullRequests?.nodes.find((n) => !n.isCrossRepository) ??
    null
  );
}

async function query(
  cfg: Config,
  ref: PrRef,
  selection: string,
  signal?: AbortSignal,
) {
  const { data } = await graphql<{
    repository: {
      pullRequest?: Node | null;
      pullRequests?: { nodes: Node[] };
    } | null;
  }>(
    cfg.github,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selection} } }
     fragment P on PullRequest { number title headRefName baseRefName headRefOid isCrossRepository }`,
    { owner: ref.owner, name: ref.repo },
    signal,
  );
  return data;
}

function toStackPr(ref: PrRef, n: Node): StackPr {
  return {
    prId: prIdOf(ref.owner, ref.repo, n.number),
    number: n.number,
    title: n.title,
    headRef: n.headRefName,
    baseRef: n.baseRefName,
    headSha: n.headRefOid,
  };
}
