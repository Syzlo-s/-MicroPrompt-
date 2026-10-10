export interface Note {
  /** UUID，小写带连字符（与 C++ 版 QUuid::WithoutBraces 一致） */
  id: string;
  title: string;
  /** HTML 富文本，如 <p>正文</p><hr data-style="0"/><span data-refblock="...">　</span> */
  content: string;
  /** 0=纯白 1=纸张黄 */
  background: number;
  /** 0=黑(默认) 1=红 2=蓝 */
  color: number;
  /** ISO8601 本地时间 "yyyy-MM-ddTHH:mm:ss" */
  created: string;
  modified: string;
}

export interface AppData {
  notes: Note[];
  /** 键 = 引用块 uuid */
  refblocks: Record<string, string>;
}
