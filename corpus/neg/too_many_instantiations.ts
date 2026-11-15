// expect: TSL4001 at 150:3
import {
  type bool,
  type f32,
  type f64,
  type i16,
  type i32,
  type i64,
  type i8,
  type u16,
  type u32,
  type u64,
  type u8,
  type usize,
} from "@tsl/core";

function first<A, B>(a: A, _b: B): A {
  return a;
}

export function f(): void {
  first<i8, i8>(0, 0);
  first<i8, i16>(0, 0);
  first<i8, i32>(0, 0);
  first<i8, u8>(0, 0);
  first<i8, u16>(0, 0);
  first<i8, u32>(0, 0);
  first<i8, usize>(0, 0);
  first<i8, u64>(0, 0n);
  first<i8, i64>(0, 0n);
  first<i8, f32>(0, 0);
  first<i8, f64>(0, 0);
  first<i8, bool>(0, false);
  first<i16, i8>(0, 0);
  first<i16, i16>(0, 0);
  first<i16, i32>(0, 0);
  first<i16, u8>(0, 0);
  first<i16, u16>(0, 0);
  first<i16, u32>(0, 0);
  first<i16, usize>(0, 0);
  first<i16, u64>(0, 0n);
  first<i16, i64>(0, 0n);
  first<i16, f32>(0, 0);
  first<i16, f64>(0, 0);
  first<i16, bool>(0, false);
  first<i32, i8>(0, 0);
  first<i32, i16>(0, 0);
  first<i32, i32>(0, 0);
  first<i32, u8>(0, 0);
  first<i32, u16>(0, 0);
  first<i32, u32>(0, 0);
  first<i32, usize>(0, 0);
  first<i32, u64>(0, 0n);
  first<i32, i64>(0, 0n);
  first<i32, f32>(0, 0);
  first<i32, f64>(0, 0);
  first<i32, bool>(0, false);
  first<u8, i8>(0, 0);
  first<u8, i16>(0, 0);
  first<u8, i32>(0, 0);
  first<u8, u8>(0, 0);
  first<u8, u16>(0, 0);
  first<u8, u32>(0, 0);
  first<u8, usize>(0, 0);
  first<u8, u64>(0, 0n);
  first<u8, i64>(0, 0n);
  first<u8, f32>(0, 0);
  first<u8, f64>(0, 0);
  first<u8, bool>(0, false);
  first<u16, i8>(0, 0);
  first<u16, i16>(0, 0);
  first<u16, i32>(0, 0);
  first<u16, u8>(0, 0);
  first<u16, u16>(0, 0);
  first<u16, u32>(0, 0);
  first<u16, usize>(0, 0);
  first<u16, u64>(0, 0n);
  first<u16, i64>(0, 0n);
  first<u16, f32>(0, 0);
  first<u16, f64>(0, 0);
  first<u16, bool>(0, false);
  first<u32, i8>(0, 0);
  first<u32, i16>(0, 0);
  first<u32, i32>(0, 0);
  first<u32, u8>(0, 0);
  first<u32, u16>(0, 0);
  first<u32, u32>(0, 0);
  first<u32, usize>(0, 0);
  first<u32, u64>(0, 0n);
  first<u32, i64>(0, 0n);
  first<u32, f32>(0, 0);
  first<u32, f64>(0, 0);
  first<u32, bool>(0, false);
  first<usize, i8>(0, 0);
  first<usize, i16>(0, 0);
  first<usize, i32>(0, 0);
  first<usize, u8>(0, 0);
  first<usize, u16>(0, 0);
  first<usize, u32>(0, 0);
  first<usize, usize>(0, 0);
  first<usize, u64>(0, 0n);
  first<usize, i64>(0, 0n);
  first<usize, f32>(0, 0);
  first<usize, f64>(0, 0);
  first<usize, bool>(0, false);
  first<u64, i8>(0n, 0);
  first<u64, i16>(0n, 0);
  first<u64, i32>(0n, 0);
  first<u64, u8>(0n, 0);
  first<u64, u16>(0n, 0);
  first<u64, u32>(0n, 0);
  first<u64, usize>(0n, 0);
  first<u64, u64>(0n, 0n);
  first<u64, i64>(0n, 0n);
  first<u64, f32>(0n, 0);
  first<u64, f64>(0n, 0);
  first<u64, bool>(0n, false);
  first<i64, i8>(0n, 0);
  first<i64, i16>(0n, 0);
  first<i64, i32>(0n, 0);
  first<i64, u8>(0n, 0);
  first<i64, u16>(0n, 0);
  first<i64, u32>(0n, 0);
  first<i64, usize>(0n, 0);
  first<i64, u64>(0n, 0n);
  first<i64, i64>(0n, 0n);
  first<i64, f32>(0n, 0);
  first<i64, f64>(0n, 0);
  first<i64, bool>(0n, false);
  first<f32, i8>(0, 0);
  first<f32, i16>(0, 0);
  first<f32, i32>(0, 0);
  first<f32, u8>(0, 0);
  first<f32, u16>(0, 0);
  first<f32, u32>(0, 0);
  first<f32, usize>(0, 0);
  first<f32, u64>(0, 0n);
  first<f32, i64>(0, 0n);
  first<f32, f32>(0, 0);
  first<f32, f64>(0, 0);
  first<f32, bool>(0, false);
  first<f64, i8>(0, 0);
  first<f64, i16>(0, 0);
  first<f64, i32>(0, 0);
  first<f64, u8>(0, 0);
  first<f64, u16>(0, 0);
  first<f64, u32>(0, 0);
  first<f64, usize>(0, 0);
  first<f64, u64>(0, 0n);
  first<f64, i64>(0, 0n);
  first<f64, f32>(0, 0);
  first<f64, f64>(0, 0);
  first<f64, bool>(0, false);
  first<bool, i8>(false, 0);
  first<bool, i16>(false, 0);
  first<bool, i32>(false, 0);
  first<bool, u8>(false, 0);
  first<bool, u16>(false, 0);
  first<bool, u32>(false, 0);
  first<bool, usize>(false, 0);
  first<bool, u64>(false, 0n);
  first<bool, i64>(false, 0n);
  first<bool, f32>(false, 0);
  first<bool, f64>(false, 0);
  first<bool, bool>(false, false);
}
