/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ReactDOM, useEffect, useRef } from "@webpack/common";

import type { ReplyPlaceholderSuggestion } from "./placeholders";

export interface ReplyAutocompletePosition {
    left: number;
    top: number;
    width: number;
}

export const PLACEHOLDER_AUTOCOMPLETE_ID = "vc-mentions-box-placeholder-autocomplete";

export function getPlaceholderAutocompleteOptionId(key: string) {
    return `${PLACEHOLDER_AUTOCOMPLETE_ID}-${key.replaceAll(".", "-")}`;
}

interface PlaceholderAutocompleteProps {
    position: ReplyAutocompletePosition | null;
    query: string;
    suggestions: ReplyPlaceholderSuggestion[];
    selectedIndex: number;
    onSelect(placeholder: ReplyPlaceholderSuggestion, mode: "value" | "token"): void;
}

export function PlaceholderAutocomplete({
    position,
    query,
    suggestions,
    selectedIndex,
    onSelect
}: PlaceholderAutocompleteProps) {
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex, suggestions.length]);

    if (!position) return null;

    return ReactDOM.createPortal(
        <div
            id={PLACEHOLDER_AUTOCOMPLETE_ID}
            className="vc-mentions-box-autocomplete vc-mentions-box-placeholder-autocomplete"
            role="listbox"
            aria-label="Reply placeholders"
            style={{
                left: position.left,
                top: position.top,
                width: position.width
            }}
        >
            {suggestions.length ? (
                <>
                    {suggestions.map((placeholder, idx) => (
                        <button
                            id={getPlaceholderAutocompleteOptionId(placeholder.key)}
                            key={placeholder.key}
                            ref={element => {
                                itemRefs.current[idx] = element;
                            }}
                            type="button"
                            role="option"
                            className={`vc-mentions-box-autocomplete-item vc-mentions-box-placeholder-item${idx === selectedIndex ? " vc-mentions-box-autocomplete-item--active" : ""}`}
                            onMouseDown={e => {
                                e.preventDefault();
                                onSelect(placeholder, e.shiftKey ? "token" : "value");
                            }}
                            aria-selected={idx === selectedIndex}
                            title={`${placeholder.token} → ${placeholder.value}`}
                        >
                            <code className="vc-mentions-box-placeholder-token">{placeholder.token}</code>
                            <span className="vc-mentions-box-placeholder-detail">
                                <span className="vc-mentions-box-placeholder-label">{placeholder.label}</span>
                                <span className="vc-mentions-box-placeholder-description">{placeholder.description}</span>
                                <span className="vc-mentions-box-placeholder-value">→ {placeholder.value}</span>
                            </span>
                        </button>
                    ))}
                    <div className="vc-mentions-box-placeholder-hint">
                        Tab inserts value • Shift+Tab inserts placeholder
                    </div>
                </>
            ) : (
                <div className="vc-mentions-box-placeholder-empty">
                    No placeholders found{query ? ` for "${query}"` : ""}
                </div>
            )}
        </div>,
        document.body
    );
}
