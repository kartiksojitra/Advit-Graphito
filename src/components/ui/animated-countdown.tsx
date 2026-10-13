import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export type CountdownVariant = "modern" | "digital" | "minimal" | "classic";

export interface AnimatedCountdownProps {
  /** Target date to count down to. Defaults to ~21 days from first render. */
  targetDate?: Date | number | string;
  /** Visual style. */
  variant?: CountdownVariant;
  className?: string;
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  done: boolean;
}

function getTimeLeft(target: number): TimeLeft {
  const diff = Math.max(0, target - Date.now());
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor(diff / 3_600_000) % 24,
    minutes: Math.floor(diff / 60_000) % 60,
    seconds: Math.floor(diff / 1_000) % 60,
    done: diff <= 0,
  };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const cardStyles: Record<CountdownVariant, string> = {
  modern:
    "rounded-2xl border border-white/10 bg-white/[0.09] shadow-[0_8px_40px_rgba(0,0,0,0.45)] backdrop-blur-none sm:bg-white/[0.05] sm:backdrop-blur-md",
  digital:
    "rounded-lg border border-emerald-300/20 bg-black/70 shadow-[0_0_24px_rgba(52,211,153,0.15)_inset]",
  minimal: "rounded-none border-b border-white/15 bg-transparent",
  classic:
    "rounded-xl border border-white/15 bg-gradient-to-b from-white/[0.08] via-white/[0.03] to-black/40",
};

const numberStyles: Record<CountdownVariant, string> = {
  modern: "text-white",
  digital: "font-mono text-emerald-300 [text-shadow:0_0_18px_rgba(52,211,153,0.6)]",
  minimal: "font-light text-white/90",
  classic: "font-mono text-white",
};

function FlipUnit({
  value,
  label,
  variant,
}: {
  value: string;
  label: string;
  variant: CountdownVariant;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          "relative grid w-[72px] place-items-center overflow-hidden px-2 py-4 sm:w-[104px] sm:py-5",
          cardStyles[variant]
        )}
      >
        {/* flip divider line for classic */}
        {variant === "classic" && (
          <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/15" />
        )}
        <span
          key={value}
          className={cn(
            "animate-flip-digit inline-block text-4xl font-extrabold tabular-nums tracking-tight sm:text-6xl",
            numberStyles[variant]
          )}
        >
          {value}
        </span>
      </div>
      <span className="text-[10px] font-bold tracking-[0.3em] text-white/45 sm:text-xs">
        {label}
      </span>
    </div>
  );
}

export default function AnimatedCountdown({
  targetDate,
  variant = "modern",
  className,
}: AnimatedCountdownProps) {
  const target = useMemo(() => {
    if (targetDate !== undefined) return new Date(targetDate).getTime();
    // Default: ~21 days out so the demo always has something to count.
    return Date.now() + 21 * 86_400_000 + 8 * 3_600_000 + 42 * 60_000;
  }, [targetDate]);

  const [left, setLeft] = useState<TimeLeft>(() => getTimeLeft(target));

  useEffect(() => {
    setLeft(getTimeLeft(target));
    const id = window.setInterval(() => setLeft(getTimeLeft(target)), 1000);
    return () => window.clearInterval(id);
  }, [target]);

  if (left.done) {
    return (
      <div
        className={cn(
          "rounded-2xl border border-emerald-300/25 bg-emerald-300/10 px-6 py-5 text-center text-sm font-bold tracking-[0.2em] text-emerald-200",
          className
        )}
      >
        WE&apos;RE LIVE — WELCOME TO ADV!T GRAPHITO
      </div>
    );
  }

  const units = [
    { value: pad(left.days), label: "DAYS" },
    { value: pad(left.hours), label: "HOURS" },
    { value: pad(left.minutes), label: "MINS" },
    { value: pad(left.seconds), label: "SECS" },
  ];

  return (
    <div className={cn("flex items-start justify-center gap-2 sm:gap-4", className)}>
      {units.map((u, i) => (
        <div key={u.label} className="flex items-start gap-2 sm:gap-4">
          <FlipUnit value={u.value} label={u.label} variant={variant} />
          {i < units.length - 1 && variant !== "minimal" && (
            <span className="pt-4 text-2xl font-black text-white/25 sm:pt-5 sm:text-4xl">
              :
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
