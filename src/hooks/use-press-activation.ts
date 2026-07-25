import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

type PressActivationHandler<T extends HTMLElement> = (event: ReactMouseEvent<T>) => void;

interface PressActivationOptions<T extends HTMLElement> {
  readonly disabled?: boolean;
  readonly preventDefault?: boolean;
  readonly shouldActivateOnPointerDown?: (event: ReactPointerEvent<T>) => boolean;
}

export function usePressActivation<T extends HTMLElement>(
  onActivate: PressActivationHandler<T> | undefined,
  {
    disabled = false,
    preventDefault = true,
    shouldActivateOnPointerDown,
  }: PressActivationOptions<T> = {},
) {
  const suppressNextClickRef = useRef(false);
  const resetTimerRef = useRef<number | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const armClickSuppression = useCallback(() => {
    clearResetTimer();
    suppressNextClickRef.current = true;
    resetTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      resetTimerRef.current = null;
    }, 500);
  }, [clearResetTimer]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<T>) => {
      if (!onActivate || disabled || event.defaultPrevented || event.button !== 0) {
        return;
      }
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
        return;
      }
      if (shouldActivateOnPointerDown && !shouldActivateOnPointerDown(event)) {
        return;
      }

      armClickSuppression();
      if (preventDefault) {
        event.preventDefault();
      }
      onActivate(event as unknown as ReactMouseEvent<T>);
    },
    [armClickSuppression, disabled, onActivate, preventDefault, shouldActivateOnPointerDown],
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent<T>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        clearResetTimer();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!onActivate || disabled) {
        return;
      }
      onActivate(event);
    },
    [clearResetTimer, disabled, onActivate],
  );

  return {
    onClick: handleClick,
    onPointerDown: handlePointerDown,
  };
}
