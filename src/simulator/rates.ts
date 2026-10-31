/**
 * 料金表 CSV（職種・地域）の読み込みと検証
 *
 * 【方針】
 *  CSV はクライアントがコードを触らずに差し替える前提のファイル。
 *  入力ミスがあっても「それらしい金額」を出してしまうのが最も危険なため、
 *  1 行でも不正があればその CSV 全体を不採用にし、画面には試算不可の案内だけを出す。
 *  どこが不正かは errors に行番号つきで返し、コンソールで更新担当者が確認できるようにする。
 *
 * 【CSV の解析】
 *  引用符・CRLF・BOM の扱いは csv-parse に任せ、このファイルは「解析済みの行を計算に渡してよいか」の判断だけを持つ。
 *  引用符の書き方が壊れている CSV は csv-parse が例外を投げるので、推測で読み進めずに不採用にする。
 *
 * 【列仕様】 2 つの CSV は「値の列」だけが異なり、ほかは共通
 *  public/data/rates.csv   … 職種。値の列 = hourly_rate（時間単価・円・税抜）
 *  public/data/regions.csv … 派遣地域。値の列 = rate_percent（単価に掛ける割合・%）
 *
 *  id         … 半角英小文字・数字・ハイフン。重複不可（フォームの value に使う）
 *  label      … 画面に出す名前
 *  (値の列)   … 整数。範囲は TABLE_SPECS を参照。カンマ区切り「2,400」・全角数字も可
 *  sort_order … 表示順（小さい順）。整数
 *  enabled    … 1 = 表示 / 0 = 非表示（true / false も可）
 */
import { parse } from 'csv-parse/browser/esm/sync';

export interface MasterItem {
  id: string;
  label: string;
  /** 値の列（職種なら時間単価、地域なら割合 %） */
  value: number;
  sortOrder: number;
}

export interface TableError {
  /** CSV 上の行番号（ヘッダー = 1 行目）。取得失敗は 0 */
  line: number;
  message: string;
}

export type TableResult = { ok: true; items: MasterItem[] } | { ok: false; errors: TableError[] };

export interface TableSpec {
  /** エラーメッセージに出す CSV の呼び名 */
  name: string;
  valueColumn: string;
  min: number;
  max: number;
}

export const TABLE_SPECS = {
  jobs: { name: '職種', valueColumn: 'hourly_rate', min: 1, max: 99999 },
  regions: { name: '地域', valueColumn: 'rate_percent', min: 50, max: 300 },
} as const satisfies Record<string, TableSpec>;

const ID_PATTERN = /^[a-z0-9-]+$/;
const TRUE_VALUES = new Set(['1', 'true']);
const FALSE_VALUES = new Set(['0', 'false']);

/** csv-parse の info つき出力（record = セルの配列、info.lines = その行が終わった行番号） */
interface ParsedRow {
  record: string[];
  info: { lines: number };
}

/** 全角数字・桁区切りカンマを許容して整数に変換する。整数でなければ null。 */
const toInteger = (value: string): number | null => {
  const normalized = value
    .trim()
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/,/g, '');
  if (!/^-?\d+$/.test(normalized)) return null;
  return Number(normalized);
};

/** CSV テキストを行に分ける。引用符の不正などで解析できなければ TableError を返す。 */
const parseRows = (text: string): ParsedRow[] | TableError => {
  try {
    // info: true のときの戻り値（record と info の組）は csv-parse の型定義に含まれないため、ParsedRow として扱う
    return parse(text, {
      bom: true,
      // Excel が付ける末尾の空行や、途中の空行は無視する
      skip_empty_lines: true,
      // 列数の不足は csv-parse で止めず、下の検証で「どの列が空か」を案内する
      relax_column_count: true,
      info: true,
    }) as unknown as ParsedRow[];
  } catch (error) {
    const lines = (error as { lines?: unknown }).lines;
    return {
      line: typeof lines === 'number' ? lines : 0,
      message: `CSV の形式が正しくありません（引用符「"」の書き方などを確認してください）: ${(error as Error).message}`,
    };
  }
};

/** CSV テキストから有効な行の一覧を作る。不正があれば ok: false。 */
export const parseMasterTable = (text: string, spec: TableSpec): TableResult => {
  const rows = parseRows(text);
  if (!Array.isArray(rows)) return { ok: false, errors: [rows] };

  const errors: TableError[] = [];
  const columns = ['id', 'label', spec.valueColumn, 'sort_order', 'enabled'];

  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 1, message: 'CSV が空です' }] };
  }

  // 列の並び替えには耐えられるよう、位置ではなく列名で参照する
  const header = rows[0].record.map(name => name.trim());
  const missing = columns.filter(name => !header.includes(name));
  if (missing.length > 0) {
    return { ok: false, errors: [{ line: 1, message: `必須の列がありません: ${missing.join(', ')}` }] };
  }

  const items: MasterItem[] = [];
  const seenIds = new Map<string, number>();

  rows.slice(1).forEach(({ record: cells, info }) => {
    const line = info.lines;
    const get = (name: string) => (cells[header.indexOf(name)] ?? '').trim();
    const rowErrors: string[] = [];

    const id = get('id');
    if (!ID_PATTERN.test(id)) {
      rowErrors.push(`id「${id}」は半角英小文字・数字・ハイフンで入力してください`);
    } else if (seenIds.has(id)) {
      rowErrors.push(`id「${id}」が ${seenIds.get(id)} 行目と重複しています`);
    } else {
      seenIds.set(id, line);
    }

    const label = get('label');
    if (label === '') rowErrors.push('label が空です');

    const value = toInteger(get(spec.valueColumn));
    if (value === null || value < spec.min || value > spec.max) {
      rowErrors.push(
        `${spec.valueColumn}「${get(spec.valueColumn)}」は ${spec.min}〜${spec.max} の整数で入力してください`
      );
    }

    const sortOrder = toInteger(get('sort_order'));
    if (sortOrder === null) rowErrors.push(`sort_order「${get('sort_order')}」は整数で入力してください`);

    const enabledRaw = get('enabled').toLowerCase();
    if (!TRUE_VALUES.has(enabledRaw) && !FALSE_VALUES.has(enabledRaw)) {
      rowErrors.push(`enabled「${get('enabled')}」は 1 または 0 で入力してください`);
    }

    if (rowErrors.length > 0) {
      rowErrors.forEach(message => errors.push({ line, message }));
      return;
    }

    // 非表示の行も検証はする（公開時に enabled を 1 に戻した瞬間に壊れないように）
    if (TRUE_VALUES.has(enabledRaw)) {
      items.push({ id, label, value: value as number, sortOrder: sortOrder as number });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  if (items.length === 0) {
    return {
      ok: false,
      errors: [{ line: 1, message: `表示できる${spec.name}がありません（enabled がすべて 0 です）` }],
    };
  }

  items.sort((a, b) => a.sortOrder - b.sortOrder);
  return { ok: true, items };
};

/**
 * CSV のバイト列を文字列にする。
 * Excel の「CSV（コンマ区切り）」は Shift_JIS で保存されるため、UTF-8 として不正なら Shift_JIS で読み直す。
 * （「CSV UTF-8」で保存された場合はそのまま UTF-8 として読める）
 */
export const decodeCsv = (buffer: ArrayBuffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return new TextDecoder('shift_jis').decode(buffer);
  }
};

/** CSV を取得して検証する。通信エラーも ok: false として返す（例外を外に出さない）。 */
export const loadMasterTable = async (url: string, spec: TableSpec): Promise<TableResult> => {
  try {
    // FTP で CSV だけ差し替える運用のため、ブラウザキャッシュは必ずサーバーに確認させる
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      return { ok: false, errors: [{ line: 0, message: `CSV を取得できませんでした（HTTP ${response.status}）` }] };
    }
    return parseMasterTable(decodeCsv(await response.arrayBuffer()), spec);
  } catch (error) {
    return { ok: false, errors: [{ line: 0, message: `CSV を取得できませんでした（${String(error)}）` }] };
  }
};
