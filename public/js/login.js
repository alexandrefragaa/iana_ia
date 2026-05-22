// Capturando os elementos da tela de login
const btnLogin = document.getElementById('btn-login');
const inputName = document.getElementById('reg-name');

btnLogin.addEventListener('click', () => {
    const nome = inputName.value;
    
    // Trava de segurança: não deixa entrar sem nome
    if(nome.trim() === '') {
        alert('Por favor, digite seu nome antes de entrar!');
        return;
    }
    
    // Salva o nome na memória secreta do navegador
    localStorage.setItem('nomeDoUsuario', nome);
    
    // O Redirecionamento Mágico! Leva o usuário para a tela do Gemini
    window.location.href = 'chat.html'; 
});