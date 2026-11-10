/** font를 rem 사이즈로 변경 */
export function toRem(value: number): string {
  return `${value / 16}rem`;
}
