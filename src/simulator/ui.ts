/**
 * 派遣料金シミュレーター — 画面制御（公開用に作り直した最小構成）
 *
 * 【役割】
 *  2 つの入力ステップ（派遣条件 → 稼働時間）と試算結果の切替・入力検証・結果表示を担当する。
 *  CSV の読み込み / 検証は rates.ts、計算は calc.ts に分けており、このファイルは計算式を持たない。
 *
 * 【状態の持ち方】
 *  入力値は各 input / select 自体が保持し、ステップは hidden の切替だけで行う。
 *  そのため「戻る」「条件を変更する」で前のステップに戻っても入力内容は消えない。
 *
 * 【表示する条件と結果を食い違わせない】
 *  試算結果の条件欄と金額は、calculateEstimate が返した 1 つの Estimate からまとめて描画する。
 *  画面の入力欄を別途読み直して条件欄を作らないので、「条件は変えたが金額は古い」状態にならない。
 *
 * 【A11y 要件】
 *  - 表示中のステップを aria-current="step" で伝える。
 *  - ステップ切替時は見出しへフォーカスを移し、aria-live で「ステップ2/2」を読み上げる。
 *  - エラーは aria-invalid + aria-describedby でフィールドに紐付け、最初のエラー項目へフォーカスする。
 *  - CSV に不備があるときはフォームを出さず、誤った金額を表示しない。
 *
 * 【HTML】 index.html の .js-simulator
 */
import { loadMasterTable, TABLE_SPECS, type MasterItem, type TableError } from './rates';
import {
  LIMITS,
  TAX_RATE_PERCENT,
  calculateEstimate,
  formatYen,
  parseCondition,
  type ConditionKey,
  type Estimate,
} from './calc';

const STEP_COUNT = 2;
type SelectKey = 'region' | 'job';

/** CSV に不備があったとき・読み込めなかったときに閲覧者へ出す案内 */
export const UNAVAILABLE_MESSAGE = '現在、料金の試算をご利用いただけません。';

export const setupSimulator = async (root: HTMLElement) => {
  const form = root.querySelector<HTMLFormElement>('.js-simulator-form');
  const status = root.querySelector<HTMLElement>('.js-simulator-status');
  const live = root.querySelector<HTMLElement>('.js-simulator-live');
  const { ratesSrc, regionsSrc } = root.dataset;
  if (!form || !status || !ratesSrc || !regionsSrc) return;

  const panels = [...root.querySelectorAll<HTMLElement>('.js-simulator-panel')];
  const indicators = [...root.querySelectorAll<HTMLElement>('.js-simulator-indicator')];
  const inputs = [...root.querySelectorAll<HTMLInputElement>('.js-simulator-input')];
  const selects = [...root.querySelectorAll<HTMLSelectElement>('.js-simulator-select')];
  const findField = (field: string) => [...inputs, ...selects].find(element => element.dataset.field === field);

  // 入力範囲の案内は calc.ts の LIMITS から作る（検証と案内の範囲がずれないように）
  root.querySelectorAll<HTMLElement>('.js-simulator-hint').forEach(hint => {
    const { min, max } = LIMITS[hint.dataset.field as ConditionKey];
    hint.textContent = `${min}〜${max}${hint.dataset.unit ?? ''}の整数`;
  });

  const [jobs, regions] = await Promise.all([
    loadMasterTable(ratesSrc, TABLE_SPECS.jobs),
    loadMasterTable(regionsSrc, TABLE_SPECS.regions),
  ]);
  if (!jobs.ok || !regions.ok) {
    // 更新担当者向けの詳細はコンソールへ。閲覧者には金額を出さず案内だけを出す。
    const report = (src: string, errors: TableError[]) => {
      console.error('[simulator] CSV に不備があるため試算を停止しました:', src);
      console.table(errors);
    };
    if (!jobs.ok) report(ratesSrc, jobs.errors);
    if (!regions.ok) report(regionsSrc, regions.errors);
    status.textContent = UNAVAILABLE_MESSAGE;
    root.dataset.state = 'error';
    return;
  }

  const masters: Record<SelectKey, MasterItem[]> = { job: jobs.items, region: regions.items };
  selects.forEach(select => renderOptions(select, masters[select.dataset.field as SelectKey] ?? []));
  status.hidden = true;
  form.hidden = false;

  let currentStep = 1;

  /** step は 1〜2 が入力ステップ、STEP_COUNT + 1 が試算結果 */
  const showStep = (step: number) => {
    currentStep = step;
    const isResult = step > STEP_COUNT;
    panels.forEach((panel, index) => {
      panel.hidden = index + 1 !== step;
    });
    form.hidden = isResult;
    indicators.forEach((item, index) => {
      if (index + 1 === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    root.dataset.state = isResult ? 'complete' : 'input';
    // 見出しへフォーカスし、キーボード・スクリーンリーダー利用者が新しいステップの先頭から読めるようにする
    panels[step - 1]?.querySelector<HTMLElement>('.js-simulator-heading')?.focus();
    if (live) live.textContent = isResult ? '試算結果を表示しました' : `ステップ${step}/${STEP_COUNT}`;
  };

  const setError = (field: string, message: string | null) => {
    const error = root.querySelector<HTMLElement>(`.js-simulator-error[data-field="${field}"]`);
    if (error) {
      error.textContent = message ?? '';
      error.hidden = message === null;
    }
    const element = findField(field);
    element?.setAttribute('aria-invalid', String(message !== null));
    element?.classList.toggle('is-error', message !== null);
  };

  /** 選択中の地域・職種を返す。未選択はエラー表示して null。 */
  const getSelected = (field: SelectKey): MasterItem | null => {
    const item = masters[field].find(entry => entry.id === findField(field)?.value) ?? null;
    setError(field, item ? null : '選択してください');
    return item;
  };

  /** 数値欄を検証し、すべて正しければ値を返す。 */
  const getNumbers = (fields: ConditionKey[]): Partial<Record<ConditionKey, number>> | null => {
    const values: Partial<Record<ConditionKey, number>> = {};
    let isValid = true;
    fields.forEach(field => {
      const parsed = parseCondition(field, findField(field)?.value ?? '');
      setError(field, parsed.ok ? null : parsed.message);
      if (parsed.ok) values[field] = parsed.value;
      else isValid = false;
    });
    return isValid ? values : null;
  };

  /** 画面上で最初にあるエラー項目へフォーカスする */
  const focusFirstError = () => {
    panels[currentStep - 1]?.querySelector<HTMLElement>('.is-error')?.focus();
  };

  const submitStep1 = () => {
    const region = getSelected('region');
    const job = getSelected('job');
    const numbers = getNumbers(['headcount']);
    if (region && job && numbers) showStep(2);
    else focusFirstError();
  };

  const submitStep2 = () => {
    // ステップ 1 の値も計算の直前に読み直して検証する（戻って変えた値を確実に反映するため）
    const region = getSelected('region');
    const job = getSelected('job');
    const numbers = getNumbers(['headcount', 'hoursPerDay', 'daysPerMonth']);
    if (!numbers) {
      focusFirstError();
      return;
    }
    if (!region || !job) return;

    renderEstimate(
      root,
      calculateEstimate(
        region,
        job,
        numbers.headcount as number,
        numbers.hoursPerDay as number,
        numbers.daysPerMonth as number
      )
    );
    showStep(STEP_COUNT + 1);
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (currentStep === 1) submitStep1();
    else if (currentStep === 2) submitStep2();
  });

  // 入力し直したらエラー表示を消す（次の「次へ」で再検証される）
  [...inputs, ...selects].forEach(element => {
    const clear = () => setError(element.dataset.field as string, null);
    element.addEventListener('input', clear);
    element.addEventListener('change', clear);
  });

  // 「戻る」「条件を変更する」は 1 つ前のステップへ（ステップ 2 → 1、試算結果 → 2）
  root.querySelectorAll<HTMLButtonElement>('.js-simulator-back').forEach(button => {
    button.addEventListener('click', () => showStep(currentStep - 1));
  });
  root.querySelector('.js-simulator-restart')?.addEventListener('click', () => {
    form.reset();
    showStep(1);
  });
};

/** CSV の行を select の選択肢として描画する（innerHTML を使わず要素を組み立てる）。 */
const renderOptions = (select: HTMLSelectElement, items: MasterItem[]) => {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '選択してください';
  // 未選択の案内として最初だけ表示し、一覧を開いたときは選べないようにする
  placeholder.disabled = true;
  placeholder.selected = true;
  // form.reset() で未選択の状態へ戻せるよう、初期選択として記録しておく
  placeholder.defaultSelected = true;
  const options = items.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    return option;
  });
  select.replaceChildren(placeholder, ...options);
};

/** 試算結果を描画する。単価は出さない（閲覧者が料金表を逆算できないようにする元サイトの方針を踏襲）。 */
const renderEstimate = (root: HTMLElement, estimate: Estimate) => {
  const outputs: Record<string, string> = {
    total: formatYen(estimate.total),
    conditions: `${estimate.region.label}・${estimate.job.label}・${estimate.headcount}人`,
    hours: `${estimate.hoursPerDay}時間 × ${estimate.daysPerMonth}日 = ${estimate.monthlyHoursPerPerson}時間`,
    subtotal: formatYen(estimate.subtotal),
    taxRate: String(TAX_RATE_PERCENT),
    tax: formatYen(estimate.tax),
  };
  root.querySelectorAll<HTMLElement>('.js-simulator-out').forEach(output => {
    output.textContent = outputs[output.dataset.key ?? ''] ?? '';
  });
};

/** ページ内のシミュレーターをすべて初期化する */
export const initSimulators = () => {
  document.querySelectorAll<HTMLElement>('.js-simulator').forEach(root => {
    // 二重に初期化しても、イベントが重複登録されないようにする
    if (root.dataset.initialized === 'true') return;
    root.dataset.initialized = 'true';
    void setupSimulator(root);
  });
};
