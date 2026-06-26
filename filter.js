export function isValidGameContent(title, url) {
    const keywords = [
        "game", "guide", "boss", "walkthrough",
        "elden ring", "weapon", "build", "quest",
        "location", "item", "achievement"
    ];

    const text = (title + url).toLowerCase();

    return keywords.some(k => text.includes(k));
}