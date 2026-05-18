/**
 * TitleScene — the SFC-style main menu.
 *
 * Phase A adds:
 *   - 4 menu entries (ソロプレイ / オンライン / ランキング・戦績 / 設定)
 *   - An "アカウント" status bar in the top-right that opens the
 *     account dialog (Phase B stub)
 *   - A scrolling marquee across the bottom of the screen pulled
 *     from the persisted records (best score, max chain, total
 *     cleared)
 *
 * The old `落ちもの連鎖バトル` tagline is dropped per playtest
 * request.
 */

import { useCallback, useEffect, useState } from 'react';
import { audioBus } from '../audio/AudioBus';
import { AccountDialog } from '../components/AccountDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import { type AccountIdentity, loadAccount } from '../state/account';
import { applyColorModeDom } from '../state/colorMode';
import { loadRecords } from '../state/records';
import { loadSettings } from '../state/settings';

interface Props {
  onStart: () => void;
  onOnline: () => void;
  onRankings: () => void;
}

type Modal = null | 'settings' | 'account';

export function TitleScene({ onStart, onOnline, onRankings }: Props) {
  const [modal, setModal] = useState<Modal>(null);
  const [account, setAccount] = useState<AccountIdentity>(() => loadAccount());
  const [marquee] = useState(() => buildMarquee());

  // Bootstrap audio + colour mode from persisted settings the moment
  // the title scene mounts. The audio context can't be resumed until
  // the user clicks, so we wire that up below.
  useEffect(() => {
    const settings = loadSettings();
    audioBus.setBgmVolume(settings.bgmVolume);
    audioBus.setSeVolume(settings.seVolume);
    applyColorModeDom(settings.colorMode);
  }, []);

  const startBgmOnFirstInteraction = useCallback(() => {
    void audioBus.ensureUnlocked().then(() => audioBus.startBgm());
  }, []);

  const handle = useCallback((next: () => void) => {
    void audioBus.ensureUnlocked().then(() => audioBus.playSe('ui-click'));
    next();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        startBgmOnFirstInteraction();
        handle(onStart);
      } else if (e.code === 'KeyO') {
        e.preventDefault();
        startBgmOnFirstInteraction();
        handle(onOnline);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStart, onOnline, handle, startBgmOnFirstInteraction]);

  return (
    <div className="scene title-scene" onMouseDown={startBgmOnFirstInteraction}>
      <div className="title-account-strip">
        <button
          type="button"
          className="title-account-btn"
          onClick={() => handle(() => setModal('account'))}
        >
          {account.guest ? 'アカウント' : `★ ${account.playerName}`}
        </button>
      </div>

      <div className="title-content">
        <h1 className="title-logo">ChainDrop</h1>

        <div className="title-menu snes-window">
          <MenuButton label="ソロプレイ" onClick={() => handle(onStart)} primary />
          <MenuButton label="オンライン" onClick={() => handle(onOnline)} />
          <MenuButton label="ランキング・戦績" onClick={() => handle(onRankings)} />
          <MenuButton label="設定" onClick={() => handle(() => setModal('settings'))} />
        </div>
      </div>

      <div className="title-marquee" aria-hidden>
        <div className="title-marquee-track">{marquee}</div>
      </div>

      {modal === 'settings' && (
        <div className="pause-overlay">
          <SettingsDialog onClose={() => setModal(null)} />
        </div>
      )}
      {modal === 'account' && (
        <div className="pause-overlay">
          <AccountDialog
            onClose={(acc) => {
              setAccount(acc);
              setModal(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface MenuButtonProps {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

function MenuButton({ label, onClick, primary }: MenuButtonProps) {
  return (
    <button
      type="button"
      className={`title-menu-btn ${primary ? 'primary' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Build the marquee string from persisted records. Repeated three
 * times in the JSX so the CSS animation can run a seamless loop with
 * `translateX(-50%)`. Always shows SOMETHING — even on a fresh save
 * with zero records, the welcome banner gives the marquee visible
 * motion.
 */
function buildMarquee(): React.ReactNode {
  const r = loadRecords();
  const segments: string[] = [];
  if (r.solo.bestScore > 0) {
    segments.push(`★ベストスコア ${r.solo.bestScore.toLocaleString()}`);
  }
  if (r.solo.bestMaxChain > 0) {
    segments.push(`★最大連鎖 ${r.solo.bestMaxChain}`);
  }
  if (r.solo.totalCleared > 0) {
    segments.push(`★消したぷよ ${r.solo.totalCleared.toLocaleString()}`);
  }
  const wins = r.online.filter((e) => e.outcome === 'win').length;
  const losses = r.online.filter((e) => e.outcome === 'loss').length;
  if (wins + losses > 0) {
    segments.push(`★オンライン ${wins}勝 ${losses}敗`);
  }
  if (segments.length === 0) {
    segments.push('★ ChainDrop へようこそ');
    segments.push('★ ソロプレイで記録を作ろう');
    segments.push('★ オンラインで対戦しよう');
  }
  const text = `${segments.join('　　')}　　`;
  // Repeat 3 times — the CSS animation translates the inner track by
  // -33.333% per loop, giving a seamless cycle.
  return (
    <>
      <span>{text}</span>
      <span>{text}</span>
      <span>{text}</span>
    </>
  );
}
