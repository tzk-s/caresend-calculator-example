// @vitest-environment jsdom
/**
 * 画面操作（ui.ts）のテスト
 *
 * index.html のマークアップをそのまま読み込み、代表的な操作だけを確認する:
 *  - 条件を入力して試算結果が出ること、結果の条件欄と金額が一致すること
 *  - 不正な入力でエラーを出し、次のステップへ進まないこと
 *  - 条件を変更すると結果が更新されること（戻っても入力が残ること）
 *  - CSV の不備・読み込み失敗のときに金額を出さないこと
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupSimulator, UNAVAILABLE_MESSAGE } from '../src/simulator/ui';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bundled = (file: string) => fs.readFileSync(path.join(root, 'public', file), 'utf8');

/** URL ごとに返す CSV を決めて fetch を差し替える。null を渡した URL は 404 を返す。 */
const stubFetch = (files: Record<string, string | null>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const text = files[url];
      if (text === undefined || text === null) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    })
  );
};

const mount = async () => {
  document.body.replaceChildren(...new DOMParser().parseFromString(html, 'text/html').body.childNodes);
  const simulator = document.querySelector<HTMLElement>('.js-simulator') as HTMLElement;
  await setupSimulator(simulator);
  return simulator;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector) as T;
const panels = () => [...document.querySelectorAll<HTMLElement>('.js-simulator-panel')];
const visiblePanelIndex = () => panels().findIndex(panel => !panel.hidden);
const out = (key: string) => $(`.js-simulator-out[data-key="${key}"]`).textContent;

const setValue = (id: string, value: string) => {
  const element = $<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};
/** 表示中のステップの送信ボタン（次へ / 試算する）を押す */
const submit = () => panels()[visiblePanelIndex()].querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
const clickVisible = (selector: string) =>
  panels()[visiblePanelIndex()].querySelector<HTMLButtonElement>(selector)?.click();

const fillAndCalculate = (values: Record<string, string>) => {
  setValue('region', values.region);
  setValue('job', values.job);
  setValue('headcount', values.headcount);
  submit();
  setValue('hoursPerDay', values.hoursPerDay);
  setValue('daysPerMonth', values.daysPerMonth);
  submit();
};

const BASE = { region: 'tokyo-23', job: 'care-worker', headcount: '2', hoursPerDay: '8', daysPerMonth: '20' };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('料金表が正しいとき', () => {
  beforeEach(() => {
    stubFetch({ 'data/rates.csv': bundled('data/rates.csv'), 'data/regions.csv': bundled('data/regions.csv') });
  });

  it('CSV の有効な行だけを選択肢にし、入力範囲の案内を出す', async () => {
    await mount();
    const jobs = [...$<HTMLSelectElement>('#job').options].map(option => option.value);
    // 先頭は未選択の案内。enabled=0 のケアマネジャーは出さない
    expect(jobs).toEqual(['', 'care-staff', 'care-beginner', 'care-worker', 'nurse']);
    expect($('#headcount-hint').textContent).toBe('1〜20人の整数');
    expect($('.js-simulator-form').hidden).toBe(false);
  });

  it('条件を入力すると、条件欄と金額が同じ試算から表示される', async () => {
    await mount();
    fillAndCalculate(BASE);
    // 介護福祉士 1,500 円 × 東京都（23区）120% = 1,800 円 → × 8 時間 × 20 日 × 2 人
    expect(visiblePanelIndex()).toBe(2);
    expect(out('conditions')).toBe('東京都（23区）・介護福祉士・2人');
    expect(out('hours')).toBe('8時間 × 20日 = 160時間');
    expect(out('subtotal')).toBe('576,000');
    expect(out('tax')).toBe('57,600');
    expect(out('total')).toBe('633,600');
    expect($('.js-simulator-live').textContent).toBe('試算結果を表示しました');
  });

  it('不正な入力ではエラーを出し、次のステップへ進まない', async () => {
    await mount();
    setValue('job', 'care-worker');
    setValue('headcount', 'abc');
    submit();
    expect(visiblePanelIndex()).toBe(0);
    expect($('#region-error').textContent).toBe('選択してください');
    expect($('#headcount-error').textContent).toBe('半角の整数で入力してください');
    expect($('#headcount').getAttribute('aria-invalid')).toBe('true');
    // 最初のエラー項目（派遣地域）へフォーカスする
    expect(document.activeElement).toBe($('#region'));

    setValue('region', 'other');
    setValue('headcount', '1');
    submit();
    setValue('hoursPerDay', '13');
    setValue('daysPerMonth', '0');
    submit();
    expect(visiblePanelIndex()).toBe(1);
    expect($('#hoursPerDay-error').textContent).toBe('1〜12の範囲で入力してください');
    expect($('#daysPerMonth-error').textContent).toBe('1〜23の範囲で入力してください');
    expect(out('total')).toBe('');
  });

  it('入力し直すとエラー表示が消える', async () => {
    await mount();
    submit();
    expect($('#headcount-error').hidden).toBe(false);
    setValue('headcount', '3');
    expect($('#headcount-error').hidden).toBe(true);
    expect($('#headcount').getAttribute('aria-invalid')).toBe('false');
  });

  it('条件を変更すると、入力が残ったまま結果が更新される', async () => {
    await mount();
    fillAndCalculate(BASE);
    expect(out('total')).toBe('633,600');

    // 試算結果 → ステップ 2（入力は残っている）
    clickVisible('.js-simulator-back');
    expect(visiblePanelIndex()).toBe(1);
    expect($<HTMLInputElement>('#daysPerMonth').value).toBe('20');
    setValue('daysPerMonth', '10');
    submit();
    expect(out('hours')).toBe('8時間 × 10日 = 80時間');
    expect(out('total')).toBe('316,800');

    // ステップ 1 まで戻って職種を変えても、計算の直前に読み直して反映する
    clickVisible('.js-simulator-back');
    clickVisible('.js-simulator-back');
    expect(visiblePanelIndex()).toBe(0);
    setValue('job', 'nurse');
    submit();
    submit();
    // 看護師 2,000 円 × 120% = 2,400 円 → × 8 時間 × 10 日 × 2 人 = 384,000 円 + 税 38,400 円
    expect(out('conditions')).toBe('東京都（23区）・看護師・2人');
    expect(out('total')).toBe('422,400');
  });

  it('「最初からやり直す」で入力を消してステップ 1 に戻る', async () => {
    await mount();
    fillAndCalculate(BASE);
    clickVisible('.js-simulator-restart');
    expect(visiblePanelIndex()).toBe(0);
    expect($<HTMLSelectElement>('#job').value).toBe('');
    expect($<HTMLInputElement>('#headcount').value).toBe('');
    expect($('.js-simulator-indicator[aria-current="step"]').textContent).toBe('派遣条件');
  });
});

describe('料金表に問題があるとき', () => {
  it('CSV に不備があれば、フォームも金額も出さずに案内だけを出す', async () => {
    const duplicated = `${bundled('data/rates.csv')}care-worker,介護福祉士（重複）,1600,60,1\n`;
    stubFetch({ 'data/rates.csv': duplicated, 'data/regions.csv': bundled('data/regions.csv') });
    const simulator = await mount();
    expect($('.js-simulator-status').textContent).toBe(UNAVAILABLE_MESSAGE);
    expect($('.js-simulator-form').hidden).toBe(true);
    expect(simulator.dataset.state).toBe('error');
    expect($<HTMLSelectElement>('#job').options).toHaveLength(0);
    expect(out('total')).toBe('');
    // 更新担当者向けに、どの CSV のどこが不正かをコンソールへ出す
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CSV に不備'), 'data/rates.csv');
    expect(console.table).toHaveBeenCalledWith([{ line: 7, message: 'id「care-worker」が 4 行目と重複しています' }]);
  });

  it('CSV を取得できなければ、同じく試算を止める', async () => {
    stubFetch({ 'data/rates.csv': bundled('data/rates.csv'), 'data/regions.csv': null });
    await mount();
    expect($('.js-simulator-status').textContent).toBe(UNAVAILABLE_MESSAGE);
    expect($('.js-simulator-form').hidden).toBe(true);
    expect(console.table).toHaveBeenCalledWith([{ line: 0, message: 'CSV を取得できませんでした（HTTP 404）' }]);
  });
});
