export const DEFAULT_KNOWLEDGE_URL = 'https://www.youtube.com/results?search_query=nuild+end+game+dbd&sp=EgIIAw%253D%253D';
const STORAGE_KEY = 'iana_knowledge_job';
const FINAL_STATUSES = new Set(['completed', 'partial', 'failed']);

export function isFinalJob(job) {
    return FINAL_STATUSES.has(job?.status);
}

function count(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }

export function formatJobSummary(job) {
    const available = count(job?.document_count);
    const learned = count(job?.learned_count);
    const summary = `${available} fonte(s) disponível(is); ${learned} nova(s) ou atualizada(s).`;
    if (job?.status === 'failed') return job.error || 'A importação falhou. Consulte os motivos abaixo.';
    if (job?.status === 'partial') return `Importação concluída com limitações. ${summary} Consulte os motivos de cada fonte.`;
    if (job?.status === 'completed') return available > 0 ? `Importação concluída. ${summary}` : 'Importação concluída sem texto salvo. Consulte os motivos de cada fonte.';
    if (job?.status === 'running') return 'Extraindo textos e verificando as fontes. Isso pode levar alguns minutos…';
    return 'Tarefa recebida. Aguardando o início da extração…';
}

export function sourceLink(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

export function resultLabel(status) {
    return ({ learned: 'Texto salvo', existing: 'Já disponível', skipped: 'Sem texto salvo', failed: 'Falha', extracted: 'Texto extraído', queued: 'Aguardando', running: 'Extraindo' })[status] || 'Resultado informado';
}

export function capabilitySummary(capabilities = {}) {
    const notes = [];
    if (capabilities.youtube_search === false) notes.push('A busca do YouTube não está disponível neste ambiente.');
    if (capabilities.asr_gemini === false) notes.push('A transcrição de áudio não está configurada. Vídeos precisam de legendas/transcrição disponível.');
    if (capabilities.youtube_captions === false) notes.push('A extração de legendas do YouTube não está disponível neste ambiente.');
    if (capabilities.generative_model === false) notes.push('A geração de respostas precisa de um provedor configurado.');
    return notes.join(' ');
}

function jobMessage(job) {
    const warnings = Array.isArray(job?.warnings) ? job.warnings.filter(warning => typeof warning === 'string' && warning.trim()) : [];
    return `${formatJobSummary(job)}${warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''}`;
}

export function initializeKnowledgeUI(doc = document, fetchImpl = fetch) {
    const dialog = doc.getElementById('knowledge-dialog');
    const form = doc.getElementById('knowledge-form');
    if (!dialog || !form) return;
    const progress = doc.getElementById('knowledge-progress');
    const sources = doc.getElementById('knowledge-sources');
    const results = doc.getElementById('knowledge-results');
    const auth = doc.getElementById('knowledge-auth');
    const learn = doc.getElementById('knowledge-learn');
    let timer = null;
    let generation = 0;
    let busy = false;
    let authenticated = false;
    let activeJobId = null;
    try { activeJobId = sessionStorage.getItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }

    function rememberJob(id) {
        activeJobId = id;
        try { if (id) sessionStorage.setItem(STORAGE_KEY, id); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* Polling still works without storage. */ }
    }

    function controls() {
        form.querySelectorAll('input, button').forEach(element => { element.disabled = !authenticated || busy; });
        learn.textContent = busy ? 'Extraindo conteúdo…' : 'Aprender com esta fonte';
        auth.hidden = authenticated;
    }

    function status(message, state = '') {
        progress.textContent = message;
        progress.dataset.state = state;
    }

    async function api(path = '', options = {}) {
        let response;
        try {
            response = await fetchImpl(`/api/v1/knowledge${path}`, { credentials: 'same-origin', ...options });
        } catch { throw new Error('Não foi possível conectar à base de conhecimento. Tente novamente.'); }
        let data;
        try { data = await response.json(); } catch { throw new Error('A base retornou uma resposta inválida. Tente novamente.'); }
        if (response.status === 401) {
            authenticated = false;
            busy = false;
            sources.replaceChildren();
            results.replaceChildren();
            doc.getElementById('knowledge-stats').textContent = '';
            doc.getElementById('knowledge-capabilities').textContent = '';
            controls();
            throw Object.assign(new Error('Entre na sua conta para usar a base de conhecimento.'), { status: 401 });
        }
        if (!response.ok) throw Object.assign(new Error(data.mensagem || data.error || 'Não foi possível acessar esta fonte.'), { status: response.status });
        authenticated = true;
        controls();
        return data;
    }

    function linkedTitle(item, url, title) {
        const link = sourceLink(url);
        if (link) {
            const anchor = doc.createElement('a');
            anchor.href = link;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.textContent = title || link;
            item.appendChild(anchor);
        } else {
            const text = doc.createElement('span');
            text.textContent = title || 'Fonte sem link público';
            item.appendChild(text);
        }
    }

    function meta(item, text) {
        const span = doc.createElement('span');
        span.className = 'knowledge-source-meta';
        span.textContent = text;
        item.appendChild(span);
    }

    function renderResults(items) {
        results.replaceChildren();
        for (const result of Array.isArray(items) ? items : []) {
            const item = doc.createElement('li');
            linkedTitle(item, result.url || result.source_url, result.titulo || result.title);
            meta(item, `${resultLabel(result.status)}${result.reason || result.error ? ` · ${result.reason || result.error}` : ''}`);
            results.appendChild(item);
        }
    }

    async function loadInventory(version = generation) {
        const data = await api();
        if (version !== generation || !dialog.open) return;
        const stats = data.stats || {};
        doc.getElementById('knowledge-stats').textContent = `${count(stats.documents)} fonte(s) salva(s) · ${count(stats.chunks)} trecho(s) para consulta`;
        doc.getElementById('knowledge-capabilities').textContent = capabilitySummary(data.capabilities);
        sources.replaceChildren();
        const documents = Array.isArray(data.documents) ? data.documents : [];
        if (!documents.length) {
            const empty = doc.createElement('li');
            empty.className = 'knowledge-empty';
            empty.textContent = 'Nenhum texto foi salvo ainda. Adicione uma fonte acima para começar.';
            sources.appendChild(empty);
        }
        for (const source of documents) {
            const item = doc.createElement('li');
            linkedTitle(item, source.source_url || source.url, source.title || source.titulo);
            const chunkCount = source.chunk_count ?? source.chunks;
            const details = ['Texto disponível para consulta'];
            if (Number.isInteger(chunkCount)) details.push(`${chunkCount} trecho(s)`);
            if (source.content_kind || source.kind) details.push(String(source.content_kind || source.kind));
            meta(item, details.join(' · '));
            sources.appendChild(item);
        }
    }

    async function pollJob(id, version = generation) {
        if (!dialog.open || version !== generation) return;
        clearTimeout(timer);
        try {
            const data = await api(`/jobs/${encodeURIComponent(id)}`);
            if (!dialog.open || version !== generation) return;
            if (!data.job || data.job.id !== id) throw new Error('Não foi possível identificar a tarefa de importação.');
            const job = data.job;
            status(jobMessage(job), job.status);
            renderResults(job.results);
            busy = !isFinalJob(job);
            controls();
            if (isFinalJob(job)) {
                rememberJob(null);
                try { await loadInventory(version); } catch (error) { status(`${jobMessage(job)} Não foi possível atualizar a lista: ${error.message}`, 'failed'); }
            } else {
                timer = setTimeout(() => pollJob(id, version), 2000);
            }
        } catch (error) {
            if (!dialog.open || version !== generation) return;
            busy = false;
            if ([401, 404].includes(error.status)) rememberJob(null);
            controls();
            status(`${error.message}${activeJobId ? ' Use Atualizar para acompanhar a tarefa novamente.' : ''}`, 'failed');
        }
    }

    async function refresh() {
        const version = generation;
        try {
            await loadInventory(version);
            if (!dialog.open || version !== generation) return;
            if (activeJobId) {
                busy = true;
                controls();
                await pollJob(activeJobId, version);
            } else if (!busy) {
                status('A base está pronta. Adicione uma fonte para extrair seu conteúdo.');
            }
        } catch (error) { if (dialog.open && version === generation) status(error.message, 'failed'); }
    }

    doc.getElementById('btn-knowledge')?.addEventListener('click', () => {
        if (!dialog.open) dialog.showModal();
        generation++;
        controls();
        return refresh();
    });
    doc.getElementById('knowledge-close')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; clearTimeout(timer); });
    doc.getElementById('knowledge-login')?.addEventListener('click', () => {
        dialog.close();
        globalThis.mostrarTela?.('tela-login');
    });
    doc.getElementById('knowledge-refresh')?.addEventListener('click', refresh);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !authenticated || !form.reportValidity()) return;
        busy = true;
        controls();
        results.replaceChildren();
        status('Enviando a fonte para extração…');
        try {
            const data = await api('/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: doc.getElementById('knowledge-url').value.trim(),
                    max_videos: Number(doc.getElementById('knowledge-videos').value),
                    recent_days: Number(doc.getElementById('knowledge-days').value)
                })
            });
            if (!data.job?.id) throw new Error('A base não informou uma tarefa válida.');
            rememberJob(data.job.id);
            await pollJob(data.job.id, generation);
        } catch (error) {
            busy = false;
            controls();
            status(error.message, 'failed');
        }
    });
    controls();
}

if (typeof document !== 'undefined') initializeKnowledgeUI();
