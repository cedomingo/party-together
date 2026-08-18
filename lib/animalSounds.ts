// Cartoonish animal sounds for the character cards, synthesized entirely in
// the browser with the Web Audio API - no audio files, no network, no
// licensing. Each character in the global 25-character roster maps to an
// animal (keyed by name, see CHARACTER_ANIMAL); playCharacterSound() builds
// a short synthesized impression of that animal (Buzzby → bee buzz, Roary →
// lion roar, Oinky → pig oink, ...) and plays it through a lazily-created
// AudioContext (created on the first user tap, so autoplay policies are
// satisfied).
//
// Sounds are deliberately short (~0.3–1s), quiet, and each play cuts off the
// previous one, so rapid card-tapping stays crisp instead of stacking up a
// wall of noise.
//
// The name → animal mapping is a best-effort read of the character art/names
// (the ones that were guesses are flagged in CHARACTER_ANIMAL) - each entry
// is a one-line fix if the actual art disagrees.

import type { KeyboardEvent } from "react";

export type AnimalSound =
  | "bee"
  | "chicken"
  | "pig"
  | "lion"
  | "cow"
  | "cat"
  | "sheep"
  | "dog"
  | "mouse"
  | "frog"
  | "fish"
  | "sloth"
  | "snake"
  | "spider"
  | "crab"
  | "turtle"
  | "bear"
  | "crocodile"
  | "bull"
  | "fox"
  | "rabbit"
  | "monster"
  | "hummingbird"
  | "twinkle"
  | "cheetah";

/**
 * Character name → animal. Keyed by name because the `characters` table
 * enforces unique names (the seed script refuses duplicates) and both games
 * share the same global roster.
 */
export const CHARACTER_ANIMAL: Record<string, AnimalSound> = {
  Gork: "monster",
  Pip: "mouse",
  Glub: "fish",
  Ferdinand: "bull",
  Whirly: "hummingbird", // guess: whirl of hummingbird wings
  Binky: "rabbit", // guess: a "binky" is a rabbit's happy hop
  Cluck: "chicken",
  Crockett: "crocodile",
  Bamboozle: "fox", // guess: trickster fox
  Slyvester: "cat",
  Snooze: "sloth",
  Roary: "lion",
  Oinky: "pig",
  Hoppy: "frog", // guess: ribbit
  Twinkle: "twinkle", // guess: sparkle arpeggio
  Dotty: "cow", // guess: cow spots
  Shelldon: "turtle",
  Squiggles: "snake",
  Pinchy: "crab",
  Barnaby: "bear",
  Webster: "spider",
  Buzzby: "bee",
  Scruffy: "dog",
  Woolly: "sheep",
  Speedo: "cheetah", // guess: the fast one
};

// ---------------------------------------------------------------------------
// Audio plumbing
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
/** Every source/LFO scheduled since the last play - cut them all when a new
 *  sound starts so taps never pile up. */
let activeSources: AudioScheduledSourceNode[] = [];

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function stopActive(): void {
  if (!audioCtx) return;
  for (const src of activeSources) {
    try {
      src.stop(audioCtx.currentTime);
    } catch {
      // Already stopped - fine.
    }
  }
  activeSources = [];
}

interface ToneOptions {
  type?: OscillatorType;
  from: number;
  to: number;
  at?: number;
  duration: number;
  volume?: number;
  filter?: { type: BiquadFilterType; frequency: number };
}

function tone(ctx: AudioContext, dest: AudioNode, o: ToneOptions): void {
  const t0 = ctx.currentTime + (o.at ?? 0);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(Math.max(o.from, 1), t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(o.to, 1), t0 + o.duration);

  const gain = ctx.createGain();
  const volume = o.volume ?? 0.15;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.duration);

  let node: AudioNode = osc;
  if (o.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter.type;
    filter.frequency.value = o.filter.frequency;
    node.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(dest);

  osc.start(t0);
  osc.stop(t0 + o.duration + 0.05);
  activeSources.push(osc);
}

function noise(
  ctx: AudioContext,
  dest: AudioNode,
  o: {
    at?: number;
    duration: number;
    volume?: number;
    filter?: { type: BiquadFilterType; frequency: number };
  }
): void {
  const t0 = ctx.currentTime + (o.at ?? 0);
  const bufferSize = Math.max(1, Math.ceil(ctx.sampleRate * o.duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  const volume = o.volume ?? 0.15;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.duration);

  let node: AudioNode = src;
  if (o.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter.type;
    filter.frequency.value = o.filter.frequency;
    node.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(dest);

  src.start(t0);
  activeSources.push(src);
}

/** LFO that modulates `param` around its current value (growls, snores,
 *  buzzes). Returns the oscillator so callers can schedule its stop. */
function lfo(ctx: AudioContext, param: AudioParam, rate: number, depth: number): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.frequency.value = rate;
  const amp = ctx.createGain();
  amp.gain.value = depth;
  osc.connect(amp);
  amp.connect(param);
  osc.start();
  activeSources.push(osc);
  return osc;
}

// ---------------------------------------------------------------------------
// One synth per animal - each is a short, quiet, recognizable cartoon take.
// ---------------------------------------------------------------------------

const SOUNDS: Record<AnimalSound, (ctx: AudioContext, dest: AudioNode) => void> = {
  bee(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, t0);
    lfo(ctx, osc.frequency, 50, 45); // fast pitch wobble = buzzing wings

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
    gain.gain.setValueAtTime(0.12, t0 + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1000;
    filter.Q.value = 1.5;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.7);
    activeSources.push(osc);
  },

  chicken(ctx, dest) {
    for (let i = 0; i < 3; i++) {
      tone(ctx, dest, {
        type: "square",
        from: 320,
        to: 210,
        at: i * 0.13,
        duration: 0.07,
        volume: 0.1,
      });
    }
  },

  pig(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "sawtooth",
        from: 380 - i * 80,
        to: 220,
        at: i * 0.22,
        duration: 0.2,
        volume: 0.14,
        filter: { type: "bandpass", frequency: 900 }, // nasal "oink"
      });
    }
  },

  lion(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(130, t0);
    osc.frequency.exponentialRampToValueAtTime(65, t0 + 0.9);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t0);
    lfo(ctx, gain.gain, 8, 0.05); // slow growl tremolo

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1);
    activeSources.push(osc);
  },

  cow(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(95, t0 + 0.85);
    lfo(ctx, osc.frequency, 6, 12); // gentle "moo" wobble

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.95);
    activeSources.push(osc);
  },

  cat(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(500, t0);
    osc.frequency.exponentialRampToValueAtTime(950, t0 + 0.22); // up...
    osc.frequency.exponentialRampToValueAtTime(420, t0 + 0.55); // ...and down

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.65);
    activeSources.push(osc);
  },

  sheep(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "sawtooth",
        from: 260,
        to: 180,
        at: i * 0.3,
        duration: 0.28,
        volume: 0.12,
        filter: { type: "bandpass", frequency: 900 }, // nasal "baa"
      });
    }
  },

  dog(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "sawtooth",
        from: 160,
        to: 85,
        at: i * 0.18,
        duration: 0.14,
        volume: 0.16,
        filter: { type: "lowpass", frequency: 600 },
      });
    }
  },

  mouse(ctx, dest) {
    tone(ctx, dest, {
      type: "sine",
      from: 1900,
      to: 2700,
      duration: 0.12,
      volume: 0.08,
    });
  },

  frog(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "square",
        from: 130,
        to: 95,
        at: i * 0.22,
        duration: 0.09,
        volume: 0.1,
        filter: { type: "lowpass", frequency: 700 },
      });
    }
  },

  fish(ctx, dest) {
    tone(ctx, dest, {
      type: "sine",
      from: 420,
      to: 90,
      duration: 0.35,
      volume: 0.16,
    });
  },

  sloth(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 100;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, t0);
    lfo(ctx, gain.gain, 2.5, 0.08); // slow snore swell

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 400;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1.05);
    activeSources.push(osc);
  },

  snake(ctx, dest) {
    noise(ctx, dest, {
      duration: 0.6,
      volume: 0.1,
      filter: { type: "highpass", frequency: 4000 },
    });
  },

  spider(ctx, dest) {
    for (let i = 0; i < 4; i++) {
      tone(ctx, dest, {
        type: "sine",
        from: 3000,
        to: 2600,
        at: i * 0.09,
        duration: 0.04,
        volume: 0.06,
      });
    }
  },

  crab(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      noise(ctx, dest, {
        at: i * 0.16,
        duration: 0.07,
        volume: 0.14,
        filter: { type: "lowpass", frequency: 1500 },
      });
    }
  },

  turtle(ctx, dest) {
    tone(ctx, dest, {
      type: "sine",
      from: 140,
      to: 110,
      duration: 0.5,
      volume: 0.1,
    });
  },

  bear(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(80, t0);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.7);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.13, t0);
    lfo(ctx, gain.gain, 10, 0.06); // rumble

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.8);
    activeSources.push(osc);
  },

  crocodile(ctx, dest) {
    noise(ctx, dest, {
      duration: 0.08,
      volume: 0.18,
      filter: { type: "bandpass", frequency: 900 },
    });
    tone(ctx, dest, {
      type: "sine",
      from: 110,
      to: 60,
      at: 0.02,
      duration: 0.14,
      volume: 0.12,
    });
  },

  bull(ctx, dest) {
    noise(ctx, dest, {
      duration: 0.1,
      volume: 0.16,
      filter: { type: "bandpass", frequency: 500 },
    });
    tone(ctx, dest, {
      type: "sine",
      from: 120,
      to: 70,
      at: 0.02,
      duration: 0.25,
      volume: 0.14,
    });
  },

  fox(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "sine",
        from: 900,
        to: 1400,
        at: i * 0.12,
        duration: 0.08,
        volume: 0.1,
      });
    }
  },

  rabbit(ctx, dest) {
    for (let i = 0; i < 2; i++) {
      tone(ctx, dest, {
        type: "sine",
        from: 1200,
        to: 1500,
        at: i * 0.14,
        duration: 0.07,
        volume: 0.07,
      });
    }
  },

  monster(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(70, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.9);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.14, t0);
    lfo(ctx, gain.gain, 5, 0.07); // slow, heavy growl

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 250;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1);
    activeSources.push(osc);
  },

  hummingbird(ctx, dest) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 700;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, t0);
    lfo(ctx, gain.gain, 30, 0.07); // fast wing flutter

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2000;
    filter.Q.value = 1;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.6);
    activeSources.push(osc);
  },

  twinkle(ctx, dest) {
    const notes = [1046, 1318, 1568]; // C6 → E6 → G6
    notes.forEach((freq, i) => {
      tone(ctx, dest, {
        type: "sine",
        from: freq,
        to: freq,
        at: i * 0.1,
        duration: 0.22,
        volume: 0.08,
      });
    });
  },

  cheetah(ctx, dest) {
    tone(ctx, dest, {
      type: "sine",
      from: 450,
      to: 1500,
      duration: 0.45,
      volume: 0.14,
    });
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Plays the synthesized animal sound for a character, by roster name.
 *  Safe to call from any click handler - failures are swallowed so a sound
 *  glitch can never break the card tap itself. */
export function playCharacterSound(characterName: string): void {
  try {
    const animal = CHARACTER_ANIMAL[characterName];
    if (!animal) return;
    const synth = SOUNDS[animal];
    if (!synth) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    stopActive();
    synth(ctx, ctx.destination);
  } catch {
    // Sound is a garnish - never let it break the game.
  }
}

/**
 * Click/keyboard props for non-button elements that should play a sound
 * (recap thumbnails, the "you picked" card, ...): makes them keyboard-
 * operable and gives the image a hover title so the sound is discoverable.
 */
export function cardSoundHandlers(characterName: string | null | undefined) {
  const play = () => playCharacterSound(characterName ?? "");
  return {
    role: "button" as const,
    tabIndex: 0,
    title: characterName ? `Play ${characterName} sound` : undefined,
    onClick: play,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        play();
      }
    },
  };
}
