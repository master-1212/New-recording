"use client";

export function KnobSlider({ label, value, onChange, suffix = "%" }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return <label className="slider-field"><span><b>{label}</b><output>{Math.round(value * 100)}{suffix}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(e) => onChange(Number(e.target.value))}/></label>;
}
