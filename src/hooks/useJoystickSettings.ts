import { useState } from 'react';
import {
  DEFAULT_CUSTOM_LAYOUT, DEFAULT_DRIVING_LAYOUT,
  isBuiltinLayout, JoystickLayout, CustomPreset, ActiveModes, DEFAULT_ACTIVE_MODES,
  loadCustomPresetsFromStorage, loadJoystickSkinFromStorage, loadJoystickHapticsFromStorage,
  loadJoystickLayoutFromStorage, loadJoystickBuiltinModesFromStorage,
  SKIN_STORAGE_KEY, HAPTICS_STORAGE_KEY, LAYOUT_STORAGE_KEY, CUSTOM_PRESETS_STORAGE_KEY,
  BUILTIN_MODES_STORAGE_KEY, genPresetId, nextPresetName, BuiltinModes,
} from '../types/joystick';

/**
 * The joystick controller's saved settings (skin, haptics, layout, presets, per-layout modes), loaded from
 * localStorage and written back on every change. Returns exactly the settings props JoystickOverlay takes, so
 * callers spread it: `<JoystickOverlay {...settings} host=... onClose=... />`.
 */
export function useJoystickSettings() {
  const [skin, setSkin] = useState<'xbox' | 'ps'>(loadJoystickSkinFromStorage);
  const [haptics, setHaptics] = useState<boolean>(loadJoystickHapticsFromStorage);
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(loadCustomPresetsFromStorage);
  const [layout, setLayout] = useState<JoystickLayout>(loadJoystickLayoutFromStorage);
  const [builtinModes, setBuiltinModes] = useState<BuiltinModes>(loadJoystickBuiltinModesFromStorage);

  const setAndPersistSkin = (v: 'xbox' | 'ps') => {
    setSkin(v);
    try { localStorage.setItem(SKIN_STORAGE_KEY, v); } catch {}
  };

  const setAndPersistHaptics = (v: boolean) => {
    setHaptics(v);
    try { localStorage.setItem(HAPTICS_STORAGE_KEY, v ? 'on' : 'off'); } catch {}
  };

  const setAndPersistLayout = (v: JoystickLayout) => {
    setLayout(v);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, v); } catch {}
  };

  const setAndPersistCustomPresets = (v: CustomPreset[]) => {
    setCustomPresets(v);
    try { localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };

  const setAndPersistBuiltinModes = (v: BuiltinModes) => {
    setBuiltinModes(v);
    try { localStorage.setItem(BUILTIN_MODES_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };

  const resolvedLayout = isBuiltinLayout(layout) || customPresets.some((p) => p.id === layout)
    ? layout : 'classic';

  const activePresetForModes = customPresets.find((p) => p.id === resolvedLayout);
  const activeModes: ActiveModes = isBuiltinLayout(resolvedLayout)
    ? builtinModes[resolvedLayout]
    : (activePresetForModes?.modes || DEFAULT_ACTIVE_MODES);

  const updatePreset = (id: string, patch: Partial<CustomPreset>) => {
    setAndPersistCustomPresets(customPresets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const setActiveModes = (patch: Partial<ActiveModes>) => {
    if (isBuiltinLayout(resolvedLayout)) {
      setAndPersistBuiltinModes({ ...builtinModes, [resolvedLayout]: { ...builtinModes[resolvedLayout], ...patch } });
    } else {
      updatePreset(resolvedLayout, { modes: { ...activeModes, ...patch } });
    }
  };

  const createPresetFromActive = () => {
    const base = customPresets.find((p) => p.id === resolvedLayout);
    const newPreset: CustomPreset = base
      ? { ...base, id: genPresetId(), name: nextPresetName(base.name, customPresets), positions: { ...base.positions } }
      : {
          id: genPresetId(),
          name: nextPresetName(resolvedLayout === 'driving' ? 'Driving' : 'Classic', customPresets),
          dpadMode: 'combined', faceMode: 'combined',
          modes: { ...activeModes },
          positions: resolvedLayout === 'classic' ? DEFAULT_CUSTOM_LAYOUT : DEFAULT_DRIVING_LAYOUT,
        };
    setAndPersistCustomPresets([...customPresets, newPreset]);
    setAndPersistLayout(newPreset.id);
  };

  const deletePreset = (id: string) => {
    setAndPersistCustomPresets(customPresets.filter((p) => p.id !== id));
    if (resolvedLayout === id) setAndPersistLayout('classic');
  };

  const renamePreset = (id: string, name: string) => {
    setAndPersistCustomPresets(customPresets.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  return {
    skin,
    onSkinChange: setAndPersistSkin,
    haptics,
    onHapticsChange: setAndPersistHaptics,
    layout: resolvedLayout,
    onLayoutChange: setAndPersistLayout,
    modes: activeModes,
    onModesChange: setActiveModes,
    customPresets,
    onCreatePreset: createPresetFromActive,
    onDeletePreset: deletePreset,
    onRenamePreset: renamePreset,
    onUpdatePreset: updatePreset,
  };
}
