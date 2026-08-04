from core import scrape_learning


def test_extrair_links_personagens_dbd_filtra_paginas_relevantes():
    html = """
    <html><body>
    <a href="/wiki/Ace_Visconti">Ace</a>
    <a href="https://deadbydaylight.fandom.com/wiki/Adam_Francis">Adam</a>
    <a href="/wiki/Category:Survivors">Survivors</a>
    <a href="/wiki/Category:Killers">Killers</a>
    <a href="/wiki/Special:Random">Random</a>
    <a href="https://example.com/other">External</a>
    </body></html>
    """

    links = scrape_learning.extrair_links_personagens_dbd(html, "https://deadbydaylight.fandom.com")

    assert links == [
        "https://deadbydaylight.fandom.com/wiki/Ace_Visconti",
        "https://deadbydaylight.fandom.com/wiki/Adam_Francis",
    ]
