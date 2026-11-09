import { main } from './main';
void main().then(code => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`Erro: ${error instanceof Error && error.name !== 'ZodError' ? error.message : 'Configuração inválida. Confira data.json e os registros do instalador.'}`);
  process.exitCode = 1;
});
