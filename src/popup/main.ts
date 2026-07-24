import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings";
import { sendMessage } from "../shared/messaging";
import type { BackgroundResponse, PopupSelectOption, PopupSettingsOptions, Settings } from "../shared/types";

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
}

function applyOptions(
  options: PopupSettingsOptions,
  selected: { departmentField: string; departmentFilterValue: string; storyPointsField: string },
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
}

async function loadSelectOptions(
  selected: { departmentField: string; departmentFilterValue: string; storyPointsField: string },
  silent = false,
): Promise<void> {
  const connection = currentConnection();
  if (!connection.baseUrl || !connection.token) {
    applyOptions(
      {
        departmentFields: [],
        departmentValues: [],
        storyPointFields: [{ value: "storyPoints", label: "Story Points (системное поле)" }],
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

  el<HTMLInputElement>("blockersEnabled").checked = settings.blockers.enabled;
  el<HTMLTextAreaElement>("doneStatuses").value = settings.blockers.doneStatusNames.join("\n");
  el<HTMLInputElement>("treatClosedAsDone").checked = settings.blockers.treatClosedAsDone;

  el<HTMLInputElement>("reworkReturnsEnabled").checked = settings.reworkReturns.enabled;

  el<HTMLInputElement>("notificationsEnabled").checked = settings.notifications.enabled;

  el<HTMLInputElement>("columnTimeEnabled").checked = settings.columnTime.enabled;
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  fillForm(settings);
  await loadSelectOptions({
    departmentField: settings.department.field,
    departmentFilterValue: settings.department.filterValue,
    storyPointsField: settings.storyPoints.field,
  }, true);

  el<HTMLSelectElement>("departmentField").addEventListener("change", () => {
    const current = readForm();
    void loadSelectOptions({
      departmentField: current.department.field,
      departmentFilterValue: "",
      storyPointsField: current.storyPoints.field,
    }, true);
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
