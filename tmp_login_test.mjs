const res = await fetch("http://127.0.0.1:3333/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "test@example.com", senha: "123456" })
});
console.log('status', res.status);
console.log('ok', res.ok);
console.log(await res.text());
