import { forwardRef, useState, type CSSProperties } from "react";

const MIN_LENGTH = 4;
const MAX_LENGTH = 12;
// Generated codes are five digits; the cells start at that width and grow for a chosen code.
const GENERATED_LENGTH = 5;
const CODE_PATTERN = new RegExp(`^[A-Za-z0-9]{${MIN_LENGTH},${MAX_LENGTH}}$`);

export const ROOM_CODE_RULE = `Use ${MIN_LENGTH} to ${MAX_LENGTH} letters or digits.`;

/** Whether a typed code has the right shape: 4 to 12 letters or digits, in any case. */
export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * One real input drawn as a row of cells. A single field keeps paste, mobile keyboards and
 * screen readers working the way people expect. Letters are upper-cased as they're typed.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  { value, onChange, id, invalid, describedBy },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const count = Math.max(GENERATED_LENGTH, value.length);
  const cells = Array.from({ length: count }, (_, i) => value[i] ?? "");
  const active = Math.min(value.length, count - 1);

  return (
    <div
      className={`code-input${invalid ? " is-invalid" : ""}${focused ? " is-focused" : ""}${count > 6 ? " is-long" : ""}`}
      style={{ "--cells": count } as CSSProperties}
    >
      <input
        ref={ref}
        id={id}
        className="code-input__field"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={MAX_LENGTH}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) =>
          onChange(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, MAX_LENGTH))
        }
      />
      <div className="code-input__cells" aria-hidden="true">
        {cells.map((char, i) => (
          <span
            key={i}
            className={`code-input__cell${char ? " is-filled" : ""}${focused && i === active ? " is-active" : ""}`}
          >
            {char}
          </span>
        ))}
      </div>
    </div>
  );
});
