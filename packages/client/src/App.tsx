import { useCallback, useEffect, useState } from 'react';
import { postOnlineMatch } from './api/records';
import { DifficultyScene } from './scenes/DifficultyScene';
import { LobbyScene } from './scenes/LobbyScene';
import { MatchLobbyScene, type MatchStartPayload } from './scenes/MatchLobbyScene';
import { type MatchResult, MatchScene } from './scenes/MatchScene';
import { type NetworkedMatchResult, NetworkedMatchScene } from './scenes/NetworkedMatchScene';
import { RankingsScene } from './scenes/RankingsScene';
import { ResultScene } from './scenes/ResultScene';
import { TitleScene } from './scenes/TitleScene';
import { loadAccount } from './state/account';
import { applyColorModeDom } from './state/colorMode';
import { type DifficultyLevel, fallIntervalFor, loadDifficulty } from './state/difficulty';
import { appendOnlineHistory, loadRecords } from './state/records';
import { loadSettings } from './state/settings';

type SceneKind =
  | 'title'
  | 'soloDifficulty'
  | 'match'
  | 'result'
  | 'lobby'
  | 'matchLobby'
  | 'networkedMatch'
  | 'rankings';

export function App() {
  const [scene, setScene] = useState<SceneKind>('title');
  const [matchKey, setMatchKey] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [matchRoomId, setMatchRoomId] = useState('');
  const [matchNickname, setMatchNickname] = useState('');
  const [networkedStart, setNetworkedStart] = useState<MatchStartPayload | null>(null);
  /** Solo difficulty for the upcoming MatchScene. Picker writes this. */
  const [soloDifficulty, setSoloDifficulty] = useState<DifficultyLevel>(() => loadDifficulty());

  // Apply persisted color mode on first paint so the user's previous
  // pick survives a reload. Settings volumes are applied lazily inside
  // the audio bus the first time it's unlocked.
  useEffect(() => {
    applyColorModeDom(loadSettings().colorMode);
  }, []);

  /** Tapped from the title screen; jumps to the difficulty picker. */
  const startMatch = useCallback(() => {
    setScene('soloDifficulty');
  }, []);

  /** Difficulty picker confirmed; spin up MatchScene with chosen pace. */
  const confirmDifficulty = useCallback((level: DifficultyLevel) => {
    setSoloDifficulty(level);
    setMatchKey((k) => k + 1);
    setScene('match');
  }, []);

  /** "Try again" from the result screen → re-use the same difficulty. */
  const restartMatch = useCallback(() => {
    setMatchKey((k) => k + 1);
    setScene('match');
  }, []);

  const handleEnd = useCallback((r: MatchResult) => {
    setResult(r);
    setScene('result');
  }, []);

  const handleQuit = useCallback(() => {
    setResult(null);
    setScene('title');
  }, []);

  const goOnline = useCallback(() => {
    setScene('lobby');
  }, []);

  const goRankings = useCallback(() => {
    setScene('rankings');
  }, []);

  const handleJoinMatch = useCallback((roomId: string, nick: string) => {
    setMatchRoomId(roomId);
    setMatchNickname(nick);
    setScene('matchLobby');
  }, []);

  const handleNetworkedMatchStart = useCallback((payload: MatchStartPayload) => {
    setNetworkedStart(payload);
    setScene('networkedMatch');
  }, []);

  const handleNetworkedMatchEnd = useCallback(
    (r: NetworkedMatchResult) => {
      // A desync is an invalid match: show the result for context but
      // DON'T pollute win/loss history with a bogus draw.
      if (r.reason !== 'desync') {
        // Resolve the opponent's nickname from the MatchStartPayload —
        // in 1v1 there's exactly one other id in playerOrder.
        const opponentId = networkedStart?.playerOrder.find((id) => id !== r.myPlayerId);
        const opponentNickname =
          (opponentId && networkedStart?.nicknamesByPlayerId[opponentId]) || '対戦相手';
        const outcome: 'win' | 'loss' | 'draw' =
          r.winnerId === null ? 'draw' : r.winnerId === r.myPlayerId ? 'win' : 'loss';
        appendOnlineHistory(loadRecords(), {
          at: new Date().toISOString(),
          opponentNickname,
          outcome,
          selfScore: r.score,
        });
        // Push to the server too — silent on failure (guests etc).
        void postOnlineMatch({ opponentName: opponentNickname, outcome, selfScore: r.score });
      }
      setResult({ score: r.score, maxChain: r.maxChain, frame: r.frame });
      setNetworkedStart(null);
      setScene('result');
    },
    [networkedStart],
  );

  const handleNetworkedQuit = useCallback(() => {
    setNetworkedStart(null);
    setScene('title');
  }, []);

  switch (scene) {
    case 'title':
      return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
    case 'soloDifficulty':
      return <DifficultyScene onConfirm={confirmDifficulty} onBack={() => setScene('title')} />;
    case 'match':
      return (
        <MatchScene
          key={matchKey}
          fallIntervalNormal={fallIntervalFor(soloDifficulty)}
          onEnd={handleEnd}
          onQuit={handleQuit}
        />
      );
    case 'result':
      if (!result) {
        // Shouldn't happen — a transition to 'result' always sets one
        // first. Warn so a races shows up in dev, and fall back safely.
        console.warn('[App] result scene with no result; falling back to title');
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
      }
      return <ResultScene result={result} onRestart={restartMatch} onTitle={handleQuit} />;
    case 'lobby':
      return <LobbyScene onJoinMatch={handleJoinMatch} onBack={() => setScene('title')} />;
    case 'matchLobby':
      return (
        <MatchLobbyScene
          roomId={matchRoomId}
          nickname={matchNickname || loadAccount().playerName}
          onLeave={() => setScene('lobby')}
          onMatchStart={handleNetworkedMatchStart}
        />
      );
    case 'rankings':
      return <RankingsScene onBack={() => setScene('title')} />;
    case 'networkedMatch':
      if (!networkedStart) {
        console.warn('[App] networkedMatch scene with no start payload; falling back to title');
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
      }
      return (
        <NetworkedMatchScene
          room={networkedStart.room}
          myPlayerId={networkedStart.myPlayerId}
          playerOrder={networkedStart.playerOrder}
          nicknamesByPlayerId={networkedStart.nicknamesByPlayerId}
          seed={networkedStart.seed}
          colorMode={networkedStart.colorMode}
          dropQueue={
            networkedStart.dropQueue as unknown as ReadonlyArray<
              readonly [
                import('@chaindrop/shared').PuyoColor,
                import('@chaindrop/shared').PuyoColor,
              ]
            >
          }
          onEnd={handleNetworkedMatchEnd}
          onQuit={handleNetworkedQuit}
        />
      );
  }
}
