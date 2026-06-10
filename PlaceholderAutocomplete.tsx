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

interface PlaceholderAutocompleteProps {
    position: ReplyAutocompletePosition | null;
    query: string;
    suggestions: ReplyPlaceholderSuggestion[];
    selectedIndex: number;
    onHover(index: number): void;
    onSelect(placeholder: ReplyPlaceholderSuggestion, mode: "value" | "token"): void;
}

export function PlaceholderAutocomplete({
    position,
    query,
    suggestions,
    selectedIndex,
    onHover,
    onSelect
}: PlaceholderAutocompleteProps) {
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex, suggestions.length]);

    if (!position) return null;

    return ReactDOM.createPortal(
        <div
            className="vc-mentions-box-autocomplete vc-mentions-box-placeholder-autocomplete"
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
                            key={placeholder.key}
                            ref={element => {
                                itemRefs.current[idx] = element;
                            }}
                            type="button"
                            className={`vc-mentions-box-autocomplete-item vc-mentions-box-placeholder-item${idx === selectedIndex ? " vc-mentions-box-autocomplete-item--active" : ""}`}
                            onMouseEnter={() => onHover(idx)}
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
