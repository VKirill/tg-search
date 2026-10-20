import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../utils/format';

type AudioPlayerProps = {
  src: string;
  durationSec: number | null;
  label?: string;
};

export function AudioPlayer({ src, durationSec, label }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      if (el.duration) setProgress(el.currentTime / el.duration);
    };
    const onEnd = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().catch(() => {});
      setPlaying(true);
    }
  };

  const dur = durationSec ?? 0;

  return (
    <div className="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button type="button" className="audio-player__btn" onClick={toggle} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="audio-player__track">
        <div className="audio-player__bar" style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="audio-player__time">{formatDuration(dur)}</span>
      {label && <span className="audio-player__label">{label}</span>}
    </div>
  );
}
