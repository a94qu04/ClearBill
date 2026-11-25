import type { Component } from 'vue'
import {
  ArrowLeftRight,
  BedDouble,
  Camera,
  Car,
  Coffee,
  Fuel,
  Gamepad2,
  Gift,
  Heart,
  Home,
  Mountain,
  Music,
  Package,
  Pill,
  Plane,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Tag,
  Ticket,
  TrainFront,
  Umbrella,
  Utensils,
  Wifi,
  Wine,
} from 'lucide-vue-next'

export type CategoryIconKey =
  | 'utensils'
  | 'coffee'
  | 'wine'
  | 'train'
  | 'plane'
  | 'car'
  | 'bed'
  | 'shopping_bag'
  | 'gift'
  | 'ticket'
  | 'camera'
  | 'music'
  | 'gamepad'
  | 'mountain'
  | 'umbrella'
  | 'heart'
  | 'pill'
  | 'fuel'
  | 'wifi'
  | 'smartphone'
  | 'home'
  | 'package'
  | 'sparkles'
  | 'tag'
  | 'arrow_left_right'

/** 分類設定中供使用者挑選之 24 款精選旅遊／生活圖示 */
export const SELECTABLE_CATEGORY_ICONS: CategoryIconKey[] = [
  'utensils',
  'coffee',
  'wine',
  'train',
  'plane',
  'car',
  'bed',
  'shopping_bag',
  'gift',
  'ticket',
  'camera',
  'music',
  'gamepad',
  'mountain',
  'umbrella',
  'heart',
  'pill',
  'fuel',
  'wifi',
  'smartphone',
  'home',
  'package',
  'sparkles',
  'tag',
]

export const CATEGORY_ICON_COMPONENTS: Record<CategoryIconKey, Component> = {
  utensils: Utensils,
  coffee: Coffee,
  wine: Wine,
  train: TrainFront,
  plane: Plane,
  car: Car,
  bed: BedDouble,
  shopping_bag: ShoppingBag,
  gift: Gift,
  ticket: Ticket,
  camera: Camera,
  music: Music,
  gamepad: Gamepad2,
  mountain: Mountain,
  umbrella: Umbrella,
  heart: Heart,
  pill: Pill,
  fuel: Fuel,
  wifi: Wifi,
  smartphone: Smartphone,
  home: Home,
  package: Package,
  sparkles: Sparkles,
  tag: Tag,
  arrow_left_right: ArrowLeftRight,
}

const BUILTIN_DEFAULT_ICON_MAP: Record<string, CategoryIconKey> = {
  cat_food: 'utensils',
  cat_transport: 'train',
  cat_lodging: 'bed',
  cat_shopping: 'shopping_bag',
  cat_entertainment: 'ticket',
  cat_daily: 'package',
  cat_other: 'tag',
  cat_settlement: 'arrow_left_right',
}

export function isValidCategoryIconKey(
  value: unknown,
): value is CategoryIconKey {
  return typeof value === 'string' && value in CATEGORY_ICON_COMPONENTS
}

export function resolveDefaultCategoryIcon(
  categoryKey: string,
): CategoryIconKey {
  return BUILTIN_DEFAULT_ICON_MAP[categoryKey] ?? 'tag'
}

export function resolveCategoryIconComponent(
  icon?: string,
  categoryKey?: string,
): Component {
  if (isValidCategoryIconKey(icon)) {
    return CATEGORY_ICON_COMPONENTS[icon]
  }
  if (categoryKey) {
    return CATEGORY_ICON_COMPONENTS[resolveDefaultCategoryIcon(categoryKey)]
  }
  return Tag
}
