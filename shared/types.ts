export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AppCode {
  title: string;
  description: string;
  html: string;
  css: string;
  js: string;
  migrate: string;
}
export interface Version {
  id: string;
  parentId: string | null;
  jobId: string | null;
  variant: number;
  code: AppCode;
  data: Json;
  baseRevision: number;
  createdAt: string;
  validation: string;
}
export interface Event {
  id: number;
  type: string;
  versionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface Instruction {
  id: string;
  text: string;
  createdAt: string;
}
export interface StudioState {
  active: Version;
  revision: number;
  csrf: string;
  versions: Version[];
  events: Event[];
  instructions: Instruction[];
  currentInstructionId: string;
  canUndo: boolean;
  job: Job | null;
}
export interface Job {
  id: string;
  status:
    | "queued"
    | "generating"
    | "validating"
    | "complete"
    | "failed"
    | "cancelled";
  prompt: string;
  count: number;
  current: number;
  attempt: number;
  message: string;
  versionIds: string[];
  startedAt: string;
  elapsedMs: number;
  tokens: number;
  tokensPerSecond: number | null;
  error: string | null;
}
export const ORIGINAL: AppCode = {
  title: "A place to begin",
  description: "Your blank canvas. Turn an idea into something you can use.",
  html: '<main class="welcome"><div class="orbit"><span>✦</span></div><p class="eyebrow">YOUR NEXT IDEA STARTS HERE</p><h1>What will you make?</h1><p>A calendar that fits your life. A game nobody has played.<br>Something you haven’t imagined yet.</p><div class="ideas"><span>A little more useful</span><span>A little more playful</span><span>Entirely your own</span></div></main>',
  css: "*{box-sizing:border-box}body{margin:0;background:#fbfaf7;color:#32372e;font-family:system-ui,sans-serif}.welcome{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px}.orbit{width:98px;height:98px;border-radius:50%;border:1px solid #d5dfc8;display:grid;place-items:center;background:#edf1e6;color:#607947;font-size:45px;margin-bottom:32px}.eyebrow{font-size:10px!important;letter-spacing:2px;color:#78846c!important;font-weight:700}h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(36px,6vw,64px);letter-spacing:-2px;margin:12px 0 18px}.welcome>p{font-size:15px;line-height:1.8;color:#7b8075}.ideas{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:30px}.ideas span{font-size:11px;border:1px solid #e3e5dd;border-radius:25px;padding:10px 14px;color:#767e6b}",
  js: "",
  migrate: "return data;",
};
