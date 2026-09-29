import { DEFAULT_SETTINGS, DEFAULT_WIP_LIMITS, loadSettings, saveSettings } from "../shared/settings";
import { sendMessage } from "../shared/messaging";
import type {
  BackgroundResponse,
  PopupSelectOption,
  PopupSettingsOptions,
  Settings,
  WipLimitRule,
} from "../shared/types";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  const status = el<HTMLElement>("status");
  status.textContent = text;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function clearStatus(): void {
  setStatus("");
}

function currentConnection(): Settings["connection"] {
  return {
    baseUrl: el<HTMLInputElement>("baseUrl").value.trim(),
    token: el<HTMLInputElement>("token").value.trim(),
  };
}

function setSelectOptions(
  select: HTMLSelectElement,
  options: PopupSelectOption[],
  selectedValue: string,
  emptyLabel: string,
): void {
  const fragment = document.createDocumentFragment();
  const allOptions = [...options];

  if (!allOptions.some((option) => option.value === "")) {
    allOptions.unshift({ value: "", label: emptyLabel });
  }

  if (
    selectedValue &&
    !allOptions.some((option) => option.value === selectedValue)
  ) {
    allOptions.push({ value: selectedValue, label: `${selectedValue} (текущее значение)` });
  }

  for (const option of allOptions) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    fragment.appendChild(node);
  }

  select.replaceChildren(fragment);
  select.value = selectedValue && allOptions.some((option) => option.value === selectedValue) ? selectedValue : "";
}

function setSelectsDisabled(disabled: boolean): void {
  el<HTMLSelectElement>("departmentField").disabled = disabled;
  el<HTMLSelectElement>("departmentFilterValue").disabled = disabled;
  el<HTMLSelectElement>("storyPointsField").disabled = disabled;
  el<HTMLSelectElement>("reviewField").disabled = disabled;
}

function applyOptions(
  options: PopupSettingsOptions,
  selected: {
    departmentField: string;
    departmentFilterValue: string;
    storyPointsField: string;
    reviewField: string;
  },
): void {
  setSelectOptions(
    el<HTMLSelectElement>("departmentField"),
    options.departmentFields,
    selected.departmentField,
    "Выберите поле отдела",
  );
  setSelectOptions(
    el<HTMLSelectElement>("departmentFilterValue"),
    options.departmentValues,
    selected.departmentFilterValue,
    "Не выбрано",
  );
  setSelectOptions(
    el<HTMLSelectElement>("storyPointsField"),
    options.storyPointFields,
    selected.storyPointsField,
    "Выберите поле SP",
  );
  setSelectOptions(
    el<HTMLSelectElement>("reviewField"),
    options.reviewFields,
    selected.reviewField,
    "Выберите поле статуса",
  );
}

async function loadSelectOptions(
  selected: {
    departmentField: string;
    departmentFilterValue: string;
    storyPointsField: string;
    reviewField: string;
  },
  silent = false,
): Promise<void> {
  const connection = currentConnection();
  if (!connection.baseUrl || !connection.token) {
    applyOptions(
      {
        departmentFields: [],
        departmentValues: [],
        storyPointFields: [{ value: "storyPoints", label: "Story Points (системное поле)" }],
        reviewFields: [],
      },
      selected,
    );
    setSelectsDisabled(true);
    if (!silent) setStatus("Укажите Base URL и токен", "err");
    return;
  }

  setSelectsDisabled(true);

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "GET_SETTINGS_OPTIONS",
      connection,
      departmentField: selected.departmentField,
    });

    if (!response.ok) {
      setSelectsDisabled(false);
      setStatus(response.error, "err");
      return;
    }
    if (!("options" in response)) {
      setSelectsDisabled(false);
      setStatus("Не удалось загрузить варианты", "err");
      return;
    }

    applyOptions(response.options, selected);
    setSelectsDisabled(false);
    if (silent) clearStatus();
  } catch (error) {
    setSelectsDisabled(false);
    setStatus(error instanceof Error ? error.message : "Ошибка загрузки вариантов", "err");
  }
}

function createWipLimitRow(rule: WipLimitRule = { match: "", limit: 5 }): HTMLElement {
  const row = document.createElement("div");
  row.className = "wip-limit-row";

  const matchInput = document.createElement("input");
  matchInput.type = "text";
  matchInput.className = "wip-match";
  matchInput.placeholder = "progress";
  matchInput.value = rule.match;
  matchInput.spellcheck = false;

  const limitInput = document.createElement("input");
  limitInput.type = "number";
  limitInput.className = "wip-limit";
  limitInput.min = "1";
  limitInput.step = "1";
  limitInput.value = String(rule.limit > 0 ? rule.limit : 5);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.title = "Удалить";
  removeBtn.setAttribute("aria-label", "Удалить правило");
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => {
    row.remove();
  });

  row.append(matchInput, limitInput, removeBtn);
  return row;
}

function fillWipLimits(rules: WipLimitRule[]): void {
  const list = el<HTMLElement>("wipLimits");
  list.replaceChildren();
  const rows = rules.length > 0 ? rules : [{ match: "", limit: 5 }];
  for (const rule of rows) {
    list.appendChild(createWipLimitRow(rule));
  }
}

function syncWipLimitsUi(): void {
  const useDefaults = el<HTMLInputElement>("wipUseDefaults").checked;
  el<HTMLElement>("wipDefaultsPreview").hidden = !useDefaults;
  el<HTMLElement>("wipCustomPanel").hidden = useDefaults;
}

function readWipLimits(): WipLimitRule[] {
  const rows = el<HTMLElement>("wipLimits").querySelectorAll<HTMLElement>(".wip-limit-row");
  const limits: WipLimitRule[] = [];
  for (const row of rows) {
    const match = row.querySelector<HTMLInputElement>(".wip-match")?.value.trim() ?? "";
    const rawLimit = Number(row.querySelector<HTMLInputElement>(".wip-limit")?.value);
    if (!match || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
    limits.push({ match, limit: Math.floor(rawLimit) });
  }
  return limits;
}

function readForm(): Settings {
  return {
    connection: {
      ...currentConnection(),
    },
    hideNativeStrip: el<HTMLInputElement>("hideNativeStrip").checked,
    overviewRedesign: el<HTMLInputElement>("overviewRedesign").checked,
    overviewExtended: el<HTMLInputElement>("overviewExtended").checked,
    priority: {
      enabled: el<HTMLInputElement>("priorityEnabled").checked,
    },
    department: {
      enabled: el<HTMLInputElement>("departmentEnabled").checked,
      field: el<HTMLSelectElement>("departmentField").value || DEFAULT_SETTINGS.department.field,
      filterValue: el<HTMLSelectElement>("departmentFilterValue").value,
      labelMap: DEFAULT_SETTINGS.department.labelMap,
    },
    storyPoints: {
      enabled: el<HTMLInputElement>("storyPointsEnabled").checked,
      field: el<HTMLSelectElement>("storyPointsField").value || DEFAULT_SETTINGS.storyPoints.field,
    },
    review: {
      enabled: el<HTMLInputElement>("reviewEnabled").checked,
      field: el<HTMLSelectElement>("reviewField").value || DEFAULT_SETTINGS.review.field,
      greenId: el<HTMLInputElement>("reviewGreenId").value.trim() || DEFAULT_SETTINGS.review.greenId,
      yellowId: el<HTMLInputElement>("reviewYellowId").value.trim() || DEFAULT_SETTINGS.review.yellowId,
      redId: el<HTMLInputElement>("reviewRedId").value.trim() || DEFAULT_SETTINGS.review.redId,
    },
    blockers: {
      enabled: el<HTMLInputElement>("blockersEnabled").checked,
      doneStatusNames: el<HTMLTextAreaElement>("doneStatuses")
        .value.split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean),
      treatClosedAsDone: el<HTMLInputElement>("treatClosedAsDone").checked,
    },
    reworkReturns: {
      enabled: el<HTMLInputElement>("reworkReturnsEnabled").checked,
    },
    notifications: {
      enabled: el<HTMLInputElement>("notificationsEnabled").checked,
    },
    columnTime: {
      enabled: el<HTMLInputElement>("columnTimeEnabled").checked,
    },
    wip: {
      enabled: el<HTMLInputElement>("wipEnabled").checked,
      borderEnabled: el<HTMLInputElement>("wipBorderEnabled").checked,
      useDefaults: el<HTMLInputElement>("wipUseDefaults").checked,
      limits: readWipLimits(),
    },
  };
}

function fillForm(settings: Settings): void {
  el<HTMLInputElement>("baseUrl").value = settings.connection.baseUrl;
  el<HTMLInputElement>("token").value = settings.connection.token;
  el<HTMLInputElement>("hideNativeStrip").checked = settings.hideNativeStrip;
  el<HTMLInputElement>("overviewRedesign").checked = settings.overviewRedesign;
  el<HTMLInputElement>("overviewExtended").checked = settings.overviewExtended;

  el<HTMLInputElement>("priorityEnabled").checked = settings.priority.enabled;

  el<HTMLInputElement>("departmentEnabled").checked = settings.department.enabled;
  el<HTMLInputElement>("storyPointsEnabled").checked = settings.storyPoints.enabled;

  el<HTMLInputElement>("reviewEnabled").checked = settings.review.enabled;
  el<HTMLInputElement>("reviewGreenId").value = settings.review.greenId;
  el<HTMLInputElement>("reviewYellowId").value = settings.review.yellowId;
  el<HTMLInputElement>("reviewRedId").value = settings.review.redId;

  el<HTMLInputElement>("blockersEnabled").checked = settings.blockers.enabled;
  el<HTMLTextAreaElement>("doneStatuses").value = settings.blockers.doneStatusNames.join("\n");
  el<HTMLInputElement>("treatClosedAsDone").checked = settings.blockers.treatClosedAsDone;

  el<HTMLInputElement>("reworkReturnsEnabled").checked = settings.reworkReturns.enabled;

  el<HTMLInputElement>("notificationsEnabled").checked = settings.notifications.enabled;

  el<HTMLInputElement>("columnTimeEnabled").checked = settings.columnTime.enabled;

  el<HTMLInputElement>("wipEnabled").checked = settings.wip.enabled;
  el<HTMLInputElement>("wipBorderEnabled").checked = settings.wip.borderEnabled;
  el<HTMLInputElement>("wipUseDefaults").checked = settings.wip.useDefaults;
  fillWipLimits(settings.wip.limits.length > 0 ? settings.wip.limits : DEFAULT_WIP_LIMITS);
  syncWipLimitsUi();
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  fillForm(settings);
  await loadSelectOptions({
    departmentField: settings.department.field,
    departmentFilterValue: settings.department.filterValue,
    storyPointsField: settings.storyPoints.field,
    reviewField: settings.review.field,
  }, true);

  el<HTMLSelectElement>("departmentField").addEventListener("change", () => {
    const current = readForm();
    void loadSelectOptions({
      departmentField: current.department.field,
      departmentFilterValue: "",
      storyPointsField: current.storyPoints.field,
      reviewField: current.review.field,
    }, true);
  });

  el<HTMLButtonElement>("wipAddBtn").addEventListener("click", () => {
    el<HTMLElement>("wipLimits").appendChild(createWipLimitRow());
  });

  el<HTMLInputElement>("wipUseDefaults").addEventListener("change", () => {
    syncWipLimitsUi();
  });

  el<HTMLButtonElement>("saveBtn").addEventListener("click", () => {
    void (async () => {
      try {
        const next = readForm();
        await saveSettings(next);
        await sendMessage({ type: "CLEAR_CACHE" });
        setStatus("Сохранено", "ok");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Ошибка сохранения", "err");
      }
    })();
  });

  el<HTMLButtonElement>("testBtn").addEventListener("click", () => {
    void (async () => {
      try {
        const next = readForm();
        await saveSettings(next);
        const response = await sendMessage<BackgroundResponse>({ type: "TEST_CONNECTION" });
        if (!response.ok) {
          if (response.code === "UNAUTHORIZED") {
            setStatus("401: проверьте токен", "err");
          } else if (response.code === "CONFIG") {
            setStatus("Укажите Base URL и токен", "err");
          } else {
            setStatus(response.error, "err");
          }
          return;
        }
        if ("message" in response) {
          setStatus(response.message, "ok");
        } else {
          setStatus("OK", "ok");
        }
        await loadSelectOptions({
          departmentField: next.department.field,
          departmentFilterValue: next.department.filterValue,
          storyPointsField: next.storyPoints.field,
          reviewField: next.review.field,
        }, true);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Ошибка проверки", "err");
      }
    })();
  });

  el<HTMLButtonElement>("clearCacheBtn").addEventListener("click", () => {
    void (async () => {
      await sendMessage({ type: "CLEAR_CACHE" });
      setStatus("Кэш очищен", "ok");
    })();
  });
}

void init();
