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
  /** 4.6.0：文件管理台里的「置顶」。旧数据缺失 = false；写盘后 C++ 版/旧版读取会忽略该字段 */
  pinned?: boolean;
}

export interface AppData {
  notes: Note[];
  /** 键 = 引用块 uuid */
  refblocks: Record<string, string>;
}
