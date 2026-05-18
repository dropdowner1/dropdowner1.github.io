/**
 * SettingsDialog — the BGM音量 / SE音量 / 色変化 panel reused by the
 * title menu and the in-match pause overlay. Every change writes back
 * to localStorage and side-effects the live audio bus / Pixi stage so
 * the player hears the change as they slide.
 *
 * The dialog is dumb about layout — its parent gives it a frame.
 */

import { useCallback, useEffect, useState } from 'react';
import { audioBus } from '../audio/AudioBus';
import { applyColorModeDom } from '../state/colorMode';
import { type ColorMode, type Settings, loadSettings, saveSettings } from '../state/settings';

interface Props {
  onClose: () => void;
  onColorModeChange?: (mode: ColorMode) => void;
  /** Title shown above the controls. Defaults to "設定". */
  title?: string;
}

const VOLUME_STEPS = Array.from({ length: 11 }, (_, i) => i);

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  standard: '標準',
  'high-contrast': '高コントラスト',
  mono: 'モノクロ',
};

export function SettingsDialog({ onClose, onColorModeChange, title = '設定' }: Props) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  // Mirror the live settings to the audio bus + DOM when the dialog
  // mounts; otherwise a user who never reloaded would miss the BGM
  // gain change made in a previous session.
  useEffect(() => {
    audioBus.setBgmVolume(settings.bgmVolume);
    audioBus.setSeVolume(settings.seVolume);
    applyColorModeDom(settings.colorMode);
  }, [settings.bgmVolume, settings.seVolume, settings.colorMode]);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      saveSettings(next);
      if (patch.bgmVolume !== undefined) audioBus.setBgmVolume(patch.bgmVolume);
      if (patch.seVolume !== undefined) {
        audioBus.setSeVolume(patch.seVolume);
        // A blip on every slide so the player hears the SE level live.
        void audioBus.ensureUnlocked().then(() => audioBus.playSe('ui-click'));
      }
      if (patch.colorMode !== undefined) {
        applyColorModeDom(patch.colorMode);
        onColorModeChange?.(patch.colorMode);
      }
    },
    [settings, onColorModeChange],
  );

  return (
    <div className="snes-window settings-dialog">
      <h2 className="settings-title">{title}</h2>

      <div className="settings-row">
        <span className="settings-label">BGM 音量</span>
        <div className="settings-stepper">
          {VOLUME_STEPS.map((n) => (
            <button
              key={n}
              type="button"
              className={`step-cell ${settings.bgmVolume >= n && n > 0 ? 'on' : ''} ${
                n === 0 && settings.bgmVolume === 0 ? 'on' : ''
              }`}
              onClick={() => update({ bgmVolume: n })}
              aria-label={`BGM 音量 ${n}`}
            >
              {n === 0 ? '0' : ''}
            </button>
          ))}
        </div>
        <span className="settings-value">{settings.bgmVolume}</span>
      </div>

      <div className="settings-row">
        <span className="settings-label">SE 音量</span>
        <div className="settings-stepper">
          {VOLUME_STEPS.map((n) => (
            <button
              key={n}
              type="button"
              className={`step-cell ${settings.seVolume >= n && n > 0 ? 'on' : ''} ${
                n === 0 && settings.seVolume === 0 ? 'on' : ''
              }`}
              onClick={() => update({ seVolume: n })}
              aria-label={`SE 音量 ${n}`}
            >
              {n === 0 ? '0' : ''}
            </button>
          ))}
        </div>
        <span className="settings-value">{settings.seVolume}</span>
      </div>

      <div className="settings-row">
        <span className="settings-label">色変化</span>
        <div className="settings-color-modes">
          {(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`color-mode-btn ${settings.colorMode === mode ? 'on' : ''}`}
              onClick={() => update({ colorMode: mode })}
            >
              {COLOR_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <p className="settings-hint">モノクロは色盲対応と高難易度モードを兼ねます。</p>

      <div className="settings-actions">
        <button type="button" className="pause-btn pause-btn-primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
