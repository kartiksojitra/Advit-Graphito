import { useEffect, useRef, useState } from "react"

import AnimatedCountdown from "@/components/ui/animated-countdown"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */
/*  AIRLOCK — a scroll-locked, scrub-driven video hero                        */
/*                                                                            */
/*  While the hero owns the screen the page cannot move: the body is pinned   */
/*  with position:fixed, the same technique modal libraries use, because      */
/*  overflow:hidden alone is not reliable across browsers. Wheel, touch and   */
/*  key input is captured and spent on video.currentTime instead, forward     */
/*  and backward. When the video reaches its end and the reader keeps         */
/*  pushing forward the page is handed back and scrolls normally; scrolling   */
/*  back up to the top takes the lock again at full progress.                 */
/*                                                                            */
/*  No dependencies beyond React. Reduced-motion readers never get locked.    */
/* -------------------------------------------------------------------------- */

/* --- Types --- */

export type AirlockTheme = "vacuum" | "ember" | "ice"

interface Palette {
  /** Page-coloured backdrop shown before the first frame decodes. */
  backdrop: string
  /** Headline and tagline colour. */
  text: string
  /** Scroll hint and signature colour. */
  muted: string
  /** Progress bar fill. */
  bar: string
}

const PALETTES: Record<AirlockTheme, Palette> = {
  vacuum: {
    backdrop: "#05070d",
    text: "#f2f4f8",
    muted: "rgba(240,244,248,0.72)",
    bar: "linear-gradient(90deg, #f59e0b, #ec4899, #22d3ee)",
  },
  ember: {
    backdrop: "#0d0705",
    text: "#fdf1e7",
    muted: "rgba(253,241,231,0.72)",
    bar: "linear-gradient(90deg, rgba(255,176,102,0.45), rgba(255,214,168,0.95))",
  },
  ice: {
    backdrop: "#04090f",
    text: "#eaf4ff",
    muted: "rgba(234,244,255,0.72)",
    bar: "linear-gradient(90deg, rgba(120,190,255,0.45), rgba(214,236,255,0.95))",
  },
}

export interface AirlockHeroProps {
  /** Video to scrub. Must be same-origin or CORS-enabled, and seekable. */
  videoSrc?: string
  /** Still shown until the video has enough data to paint. Kills the black flash. */
  posterSrc?: string
  /** Headline over the opening frames. Fades out as the scrub starts. */
  title?: string
  /** Word next to the bouncing arrow. Hidden once the reader moves. */
  scrollHint?: string
  /** Payoff line, revealed over the last fifth of the scrub. Pass "" to drop it. */
  tagline?: string
  /** Credit in the corner. Pass false to drop it. */
  signature?: { name: string; url: string } | false
  /** Input distance in pixels needed to scrub the whole video. Higher feels heavier. */
  scrubDistance?: number
  /**
   * Extra input distance spent on the last frame, after the film has run out.
   * The picture is frozen and the tagline is fully up for this stretch, so the
   * hero has somewhere to land instead of stopping dead. Set to 0 to drop it.
   */
  holdDistance?: number
  /** Named colour set. */
  theme?: AirlockTheme
  /** Label for the control that hands the page back without scrubbing. */
  skipLabel?: string
  className?: string
  style?: React.CSSProperties
}

/* --- Constants --- */

// Served through jsDelivr rather than raw.githubusercontent.com: raw hands the
// file back as application/octet-stream with nosniff, which browsers may refuse
// to treat as video. jsDelivr sends video/mp4 and honours range requests, which
// is what makes seeking work at all.
const CDN = "https://cdn.jsdelivr.net/gh/yuraoak/airlock-hero-assets@main"
const VIDEO_1080P = `${CDN}/iss-hero-1080p.mp4`
const VIDEO_720P = `${CDN}/iss-hero-720p.mp4`
const DEFAULT_POSTER = `${CDN}/iss-hero-poster.jpg`
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/** Keyboard fallback, so a reader without a wheel is never stuck. */
const KEY_STEPS: Record<string, number> = {
  ArrowDown: 140,
  ArrowUp: -140,
  PageDown: 700,
  PageUp: -700,
  " ": 700,
  End: Number.MAX_SAFE_INTEGER,
  Home: Number.MIN_SAFE_INTEGER,
}

/* --- Helpers --- */

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/* --- Component --- */

export default function AirlockHero({
  videoSrc,
  posterSrc = DEFAULT_POSTER,
  title = "THE AIRLOCK OPENS",
  scrollHint = "SCROLL",
  tagline = "Everything you know fits in one half of the frame.",
  signature = false,
  scrubDistance = 3200,
  holdDistance = 1100,
  theme = "vacuum",
  skipLabel = "Skip intro",
  className,
  style,
}: AirlockHeroProps) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const taglineRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const releaseRef = useRef<() => void>(() => {})
  const [ready, setReady] = useState(false)
  const [loadPct, setLoadPct] = useState(0)
  const [canScrub, setCanScrub] = useState(false)

  const palette = PALETTES[theme]

  // Resolution pick: desktop always 1080p; phones get 1080p too when the
  // network is fast, else the lighter 720p (1.2MB vs 3.9MB).
  const [resolvedVideoSrc] = useState(() => {
    if (videoSrc) return videoSrc
    if (typeof window === "undefined") return VIDEO_1080P
    const small = window.matchMedia?.("(max-width: 640px)").matches ?? false
    const conn = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean }
      }
    ).connection
    const fast =
      !conn || (!conn.saveData && (!conn.effectiveType || conn.effectiveType === "4g"))
    return small && !fast ? VIDEO_720P : VIDEO_1080P
  })

  useEffect(() => {
    const video = videoRef.current
    const section = sectionRef.current
    if (!video || !section) return

    const reduceMotion =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)

    let duration = 0
    let rafId = 0
    let target = 0
    let shown = 0
    let moved = false
    let seeking = false
    let queued: number | null = null
    let locked = false
    let lockedY = 0
    let touchY = 0
    /** Only a reader who was handed the page back can hand it over again. */
    let released = false
    let lastY = 0
    // Perf: small screens get cheaper painting (no per-frame blur filters),
    // and idle frames skip DOM writes + video seeks entirely.
    const coarse =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(max-width: 640px)").matches ?? false)
    let lastPaintedP = -1
    let lastPaintedMoved = false
    let lastSeekT = -1
    /** Auto-glide: a small scroll nudge plays the whole sequence slowly. */
    let autoDir: 0 | 1 | -1 = 0
    const AUTO_SPEED = 1 / 8 // full glide ≈ 8 seconds
    /** Forward glides use native playback (butter-smooth); reverse uses seeks. */
    let nativePlaying = false

    const totalDistance = coarse
      ? Math.min(scrubDistance, 1400) + Math.min(holdDistance, 500)
      : scrubDistance + holdDistance
    /** How much of the input axis the film itself occupies. */
    const scrubShare = (coarse ? Math.min(scrubDistance, 1400) : scrubDistance) / totalDistance
    /** Touch swipes cover less ground than a wheel — amplify them on phones. */
    const touchBoost = coarse ? 2 : 1

    /* --- Seeking ------------------------------------------------------- */

    function seekTo(t: number) {
      if (seeking) {
        queued = t
        return
      }
      seeking = true
      video!.currentTime = t
    }

    const onSeeked = () => {
      seeking = false
      if (queued !== null) {
        const t = queued
        queued = null
        seeking = true
        video!.currentTime = t
      }
    }

    function stopNative() {
      nativePlaying = false
      try {
        video!.pause()
      } catch {
        /* noop */
      }
    }

    /**
     * Align the film once, then let the decoder play natively at the glide
     * rate. Falls back to seek-glide if playback is refused.
     */
    function startNative() {
      if (duration <= 0 || nativePlaying) return
      try {
        video!.playbackRate = clamp((duration * AUTO_SPEED) / scrubShare, 0.5, 2)
        video!.currentTime = Math.min((target / scrubShare) * duration, duration - 0.04)
        const pr = video!.play()
        if (pr && typeof (pr as Promise<void>).then === "function") {
          ;(pr as Promise<void>)
            .then(() => {
              nativePlaying = true
            })
            .catch(() => {
              nativePlaying = false
            })
        } else {
          nativePlaying = true
        }
      } catch {
        nativePlaying = false
      }
    }

    /* --- Painting ------------------------------------------------------ */

    /**
     * `p` runs 0-1 across scrubDistance *and* holdDistance together. The film
     * only occupies the first stretch; past that everything to do with the
     * picture is pinned at its last value and the reader is spending scroll on
     * a held frame. Ending the moment the film does reads as an abrupt cut.
     */
    function paint(p: number) {
      // Nothing changed since the last paint — skip every DOM write and seek.
      // This makes idle frames nearly free, which matters most on mobile.
      if (Math.abs(p - lastPaintedP) < 0.0004 && moved === lastPaintedMoved) {
        return
      }
      lastPaintedP = p
      lastPaintedMoved = moved

      const videoP = clamp(p / scrubShare, 0, 1)

      // Stop a hair short of the duration: seeking to the very end lands
      // past the last decodable frame in some browsers and paints black.
      // Coalesce tiny seeks: mobile decoders stall if currentTime is poked
      // 60x/sec, so only seek on a meaningful step, snapped to a time grid.
      // Skipped while playing natively — the decoder drives itself.
      if (!nativePlaying && duration > 0) {
        const rawT = Math.min(videoP * duration, duration - 0.04)
        const t = Math.round(rawT * 15) / 15
        const minStep = coarse ? Math.max(duration / 120, 0.08) : Math.max(duration / 400, 0.033)
        if (Math.abs(t - lastSeekT) > minStep) {
          lastSeekT = t
          seekTo(t)
        }
      }

      const titleAlpha = 1 - clamp(videoP / 0.35, 0, 1)
      const taglineAlpha = clamp((videoP - 0.82) / 0.18, 0, 1)

      if (videoRef.current) {
        videoRef.current.style.transform = `scale(${1 + videoP * 0.06})`
      }
      if (scrimRef.current) {
        // The scrim exists to keep type legible over a daylit planet, so
        // it comes and goes with the type instead of muting the whole shot.
        scrimRef.current.style.opacity = String(Math.max(titleAlpha, taglineAlpha))
      }
      if (titleRef.current) {
        const t = titleAlpha
        titleRef.current.style.opacity = String(t)
        titleRef.current.style.transform = `translateY(${(1 - t) * -24}px) scale(${0.96 + t * 0.04})`
        // Blur filters force a repaint every frame — skip them on small screens.
        if (!coarse) titleRef.current.style.filter = `blur(${(1 - t) * 10}px)`
      }
      if (hintRef.current) {
        hintRef.current.style.opacity = moved ? "0" : "1"
      }
      if (taglineRef.current) {
        // Mirrors the headline's blur-focus move, timed as the payoff
        // once the reveal is nearly done.
        const t = taglineAlpha
        taglineRef.current.style.opacity = String(t)
        taglineRef.current.style.transform = `translateY(${(1 - t) * 20}px) scale(${0.97 + t * 0.03})`
        if (!coarse) taglineRef.current.style.filter = `blur(${(1 - t) * 8}px)`
      }
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${p})`
      }
    }

    /* --- The lock ------------------------------------------------------ */

    function engageLock() {
      if (locked) return
      locked = true
      released = false
      lockedY = window.scrollY
      const b = document.body.style
      b.position = "fixed"
      b.top = `-${lockedY}px`
      b.left = "0"
      b.right = "0"
      b.width = "100%"
    }

    function releaseLock() {
      if (!locked) return
      autoDir = 0
      stopNative()
      locked = false
      const y = lockedY
      const b = document.body.style
      b.position = ""
      b.top = ""
      b.left = ""
      b.right = ""
      b.width = ""
      window.scrollTo(0, y)
      released = true
      lastY = y
    }

    releaseRef.current = () => {
      target = shown = 1
      moved = true
      paint(1)
      releaseLock()
    }

    /**
     * Spends a gesture on the scrub. Returns true when the hero used it,
     * which is the caller's cue to swallow the event. Once the scrub is
     * finished and the reader is still pushing forward, the page is handed
     * back and the gesture falls through untouched.
     */
    function consume(deltaY: number) {
      if (!locked) return false
      // Wait for the picture to catch up with the input before letting go,
      // otherwise a single hard flick throws the page on a half-played shot.
      if (target >= 1 && shown > 0.98 && deltaY > 0) {
        autoDir = 0
        releaseLock()
        return false
      }
      // A small nudge kicks off a slow auto-glide through the whole film.
      // An opposite flick reverses it; reaching either end stops it.
      // Forward glides play natively (smooth); reverse glides seek.
      if (Math.abs(deltaY) > 4) {
        const dir = (deltaY > 0 ? 1 : -1) as 0 | 1 | -1
        if (dir < 0 && nativePlaying) stopNative()
        autoDir = dir
        if (dir > 0) startNative()
      }
      target = clamp(target + deltaY / totalDistance, 0, 1)
      if (target > 0.001) moved = true
      return true
    }

    /* --- Input --------------------------------------------------------- */

    /**
     * Hero-only fix: with no page below the hero there is nowhere to scroll
     * after release, so the scroll event that normally re-locks never fires
     * and reverse scrub is dead. If we're released, sitting at the top, and
     * the reader pushes backward, take the lock back at full progress so the
     * sequence can play backwards.
     */
    function grabForReverse() {
      if (locked || !released) return false
      if (window.scrollY > section!.offsetTop + 1) return false
      target = shown = 1
      paint(1)
      engageLock()
      return true
    }

    const onWheel = (e: WheelEvent) => {
      if (!locked && e.deltaY < 0) grabForReverse()
      if (consume(e.deltaY)) e.preventDefault()
    }

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0
    }

    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchY
      const deltaY = (touchY - y) * touchBoost
      touchY = y
      if (!locked && deltaY < 0) grabForReverse()
      if (consume(deltaY)) e.preventDefault()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const step = KEY_STEPS[e.key]
      if (step === undefined) return
      if (!locked && step < 0) grabForReverse()
      if (consume(step)) e.preventDefault()
    }

    /**
     * Climbing back into the hero takes the lock again, at the last frame,
     * so the sequence runs backwards. Direction matters: sitting at the top
     * of the page is not on its own a reason to seize the wheel, or the hero
     * would grab it the moment it mounts.
     */
    const onScroll = () => {
      if (locked || !released) return
      const y = window.scrollY
      const climbing = y < lastY
      lastY = y
      if (climbing && y <= section!.offsetTop) {
        target = shown = 1
        paint(1)
        engageLock()
      }
    }

    /* --- Wiring -------------------------------------------------------- */

    const onLoadedData = () => {
      duration = video!.duration || 0
      setReady(true)
      if (reduceMotion) {
        // Hold the payoff frame and leave the page alone.
        target = shown = 1
        moved = true
        paint(1)
      }
    }

    video.addEventListener("loadeddata", onLoadedData)
    video.addEventListener("seeked", onSeeked)

    // Premium scrubbing needs the whole file buffered — seeking an
    // unbuffered stream stalls and stutters, especially on mobile.
    // Hold a branded loader until buffered, then engage the lock.
    let bufferedEnough = false
    const markBuffered = () => {
      if (bufferedEnough) return
      bufferedEnough = true
      setLoadPct(100)
      setCanScrub(true)
      if (!reduceMotion && !locked && !released && window.scrollY <= section.offsetTop + 1) {
        engageLock()
      }
    }
    const onProgress = () => {
      try {
        const v = video!
        if (v.duration > 0 && v.buffered.length > 0) {
          const end = v.buffered.end(v.buffered.length - 1)
          setLoadPct(Math.min(99, Math.round((end / v.duration) * 100)))
          if (end >= v.duration - 0.25) markBuffered()
        }
      } catch {
        /* buffered info unavailable — fall through to timeout */
      }
    }
    const onCanPlayThrough = () => markBuffered()
    video.addEventListener("progress", onProgress)
    video.addEventListener("canplaythrough", onCanPlayThrough)
    // Instant when cached, patient on 4G, never stuck: hard fallback.
    if (video.readyState >= 4) markBuffered()
    const fallbackId = window.setTimeout(markBuffered, 12000)

    if (!reduceMotion) {
      if (bufferedEnough && window.scrollY <= section.offsetTop + 1) engageLock()

      window.addEventListener("wheel", onWheel, { passive: false })
      window.addEventListener("touchstart", onTouchStart, { passive: true })
      window.addEventListener("touchmove", onTouchMove, { passive: false })
      window.addEventListener("keydown", onKeyDown)
      window.addEventListener("scroll", onScroll, { passive: true })

      let lastT = performance.now()
      const frame = (now: number) => {
        const dt = Math.min((now - lastT) / 1000, 0.1)
        lastT = now
        // Auto-glide: keep drifting after a nudge until an end is reached.
        // Forward motion is native playback — sync progress to real frames.
        if (locked && autoDir !== 0) {
          if (nativePlaying && duration > 0) {
            if (video.ended) {
              stopNative()
            } else {
              target = clamp((video.currentTime / duration) * scrubShare, 0, 1)
            }
          } else {
            target = clamp(target + autoDir * AUTO_SPEED * dt, 0, 1)
          }
          if (target >= 1 && autoDir > 0) {
            // Hand the page back only once the picture has caught up.
            if (shown > 0.98) {
              autoDir = 0
              releaseLock()
            }
          } else if (target <= 0 && autoDir < 0) {
            autoDir = 0
          }
        }
        shown += (target - shown) * 0.15
        // Snap when converged so paint() early-returns and frames go idle.
        if (Math.abs(target - shown) < 0.0006) shown = target
        paint(shown)
        rafId = requestAnimationFrame(frame)
      }
      rafId = requestAnimationFrame(frame)
    }

    return () => {
      video.removeEventListener("loadeddata", onLoadedData)
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("progress", onProgress)
      video.removeEventListener("canplaythrough", onCanPlayThrough)
      window.clearTimeout(fallbackId)
      window.removeEventListener("wheel", onWheel)
      window.removeEventListener("touchstart", onTouchStart)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(rafId)
      releaseLock()
    }
  }, [scrubDistance, holdDistance])

  return (
    <div
      ref={sectionRef}
      className={cn("relative h-[100dvh] w-full overflow-hidden", className)}
      style={{ background: palette.backdrop, ...style }}
    >
      <video
        ref={videoRef}
        src={resolvedVideoSrc}
        poster={posterSrc}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        className="airlock-crisp absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: ready ? 1 : 0,
          transformOrigin: "center center",
          willChange: "transform",
          transition: "opacity 0.6s ease",
        }}
      />

      {/* Loader: holds the screen until the film is fully buffered,
          so every scrub seeks from cache instead of stalling the stream. */}
      <div
        className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 transition-opacity duration-700"
        style={{
          background: palette.backdrop,
          opacity: ready && canScrub ? 0 : 1,
          fontFamily: SANS,
        }}
      >
        <span
          className="font-extrabold"
          style={{
            fontSize: "clamp(13px, 2.4vw, 18px)",
            letterSpacing: "0.45em",
            color: palette.text,
            textIndent: "0.45em",
          }}
        >
          ADV!T GRAPHITO
        </span>
        <div className="h-px w-48 overflow-hidden bg-white/15 sm:w-64">
          <div
            className="h-full transition-[width] duration-300"
            style={{
              width: `${loadPct}%`,
              background: palette.bar,
            }}
          />
        </div>
        <span
          className="font-semibold tabular-nums"
          style={{ fontSize: 11, letterSpacing: "0.3em", color: palette.muted }}
        >
          LOADING {loadPct}%
        </span>
      </div>

      {/* Top and bottom falloff, so type never fights the sky. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(5,7,13,0.38), rgba(5,7,13,0) 30%, rgba(5,7,13,0.15) 70%, rgba(5,7,13,0.58))",
        }}
      />

      {/* Centre scrim. The daylit half of the planet is bright enough to
          swallow white type without it. Driven by paint(), so it is only
          there while there is type to protect. */}
      <div
        ref={scrimRef}
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 62% 44% at 50% 50%, rgba(5,7,13,0.68), rgba(5,7,13,0) 72%)",
        }}
      />

      {/* Cinematic finish: film grain + vignette mask compression artifacts
          and banding so the backdrop reads clean and sharp, not pixeled. */}
      <div className="airlock-grain pointer-events-none absolute inset-0" />
      <div className="airlock-vignette pointer-events-none absolute inset-0" />

      <div
        ref={titleRef}
        className="pointer-events-none absolute inset-0 flex items-center justify-center px-[6%] text-center"
      >
        <h1
          className="inline-block font-extrabold leading-none tracking-[-0.02em]"
          style={{
            fontFamily: SANS,
            fontSize: "clamp(30px, 7vw, 96px)",
            color: palette.text,
            textShadow: "0 4px 30px rgba(0,0,0,0.55)",
            willChange: "transform, filter, opacity",
          }}
        >
          {title}
        </h1>
      </div>

      {tagline ? (
        <div
          ref={taglineRef}
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-[8%] text-center opacity-0"
        >
          <div
            className="flex flex-col items-center gap-3 font-bold tracking-[-0.01em]"
            style={{
              fontFamily: SANS,
              lineHeight: 1.2,
              color: palette.text,
              textShadow: "0 4px 24px rgba(0,0,0,0.6)",
            }}
          >
            {tagline.includes("\n") ? (
              <>
                <span
                  style={{
                    fontSize: "clamp(11px, 1.8vw, 16px)",
                    fontWeight: 700,
                    letterSpacing: "0.35em",
                    color: palette.muted,
                  }}
                >
                  {tagline.split("\n")[0]}
                </span>
                <span
                  style={{
                    fontSize: "clamp(24px, 4.6vw, 56px)",
                    fontWeight: 800,
                  }}
                >
                  {tagline.split("\n").slice(1).join(" ")}
                </span>
                {/* Countdown under the tagline — fades in with it */}
                <AnimatedCountdown variant="modern" className="mt-3 origin-center scale-[0.65] sm:scale-[0.8]" />
              </>
            ) : (
              <span
                style={{
                  fontSize: "clamp(20px, 3.4vw, 40px)",
                }}
              >
                {tagline}
              </span>
            )}
          </div>
        </div>
      ) : null}

      <div
        ref={hintRef}
        className="pointer-events-none absolute bottom-[clamp(20px,6vh,48px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 transition-opacity duration-[400ms]"
        style={{
          color: palette.muted,
          fontFamily: SANS,
          fontSize: "clamp(10px, 1.4vw, 12px)",
          fontWeight: 600,
          letterSpacing: "0.3em",
        }}
      >
        <span>{scrollHint}</span>
        <svg
          width="14"
          height="18"
          viewBox="0 0 14 18"
          aria-hidden="true"
          style={{ animation: "airlock-bounce 1.6s ease-in-out infinite" }}
        >
          <style>{`
            @keyframes airlock-bounce {
              0%, 100% { transform: translateY(0); opacity: 0.5; }
              50% { transform: translateY(5px); opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
              [style*="airlock-bounce"] { animation: none !important; }
            }
          `}</style>
          <path
            d="M7 1 L7 17 M2 12 L7 17 L12 12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* Never trap anyone: a keyboard-reachable way straight to the page. */}
      <button
        type="button"
        onClick={() => releaseRef.current()}
        className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-semibold opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          fontFamily: SANS,
          color: palette.text,
          background: "rgba(5,7,13,0.7)",
          letterSpacing: "0.08em",
        }}
      >
        {skipLabel}
      </button>

      {/* Thin progress line — fills as the video advances. */}
      <div
        className="absolute inset-x-0 bottom-0 h-0.5"
        style={{ background: "rgba(255,255,255,0.12)" }}
      >
        <div
          ref={barRef}
          className="h-full w-full origin-left"
          style={{ background: palette.bar, transform: "scaleX(0)" }}
        />
      </div>

      {signature ? (
        <span
          className="absolute bottom-[clamp(10px,2vw,18px)] right-[clamp(12px,2.5vw,24px)] z-[2] font-medium"
          style={{
            fontFamily: SANS,
            fontSize: "clamp(11px, 1.4vw, 13px)",
            color: palette.muted,
          }}
        >
          by{" "}
          <a
            href={signature.url}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline transition-colors hover:opacity-100"
            style={{ color: "inherit" }}
          >
            {signature.name}
          </a>
        </span>
      ) : null}
    </div>
  )
}
