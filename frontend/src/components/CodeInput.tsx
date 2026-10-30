import { forwardRef, useState } from "react";

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * One real input drawn as five cells. A single field keeps paste, autofill of one-time codes,
 * mobile numeric keyboards and screen readers working the way people expect.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  { value, onChange, id, invalid, describedBy },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const cells = Array.from({ length: 5 }, (_, i) => value[i] ?? "");
  const active = Math.min(value.length, 4);

  return (
    <div className={`code-input${invalid ? " is-invalid" : ""}${focused ? " is-focused" : ""}`}>
      <input
        ref={ref}
        id={id}
        className="code-input__field"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{5}"
        maxLength={5}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
      />
      <div className="code-input__cells" aria-hidden="true">
        {cells.map((digit, i) => (
          <span
            key={i}
            className={`code-input__cell${digit ? " is-filled" : ""}${focused && i === active ? " is-active" : ""}`}
          >
            {digit}
          </span>
        ))}
      </div>
    </div>
  );
});
