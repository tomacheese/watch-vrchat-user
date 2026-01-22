/**
 * Discord 通知を管理するモジュール
 */

import { Discord, type DiscordEmbed } from '@book000/node-utils'
import type { Config } from './config'

/** 通知の種類 */
export type NotificationType = 'location-change' | 'online' | 'offline'

/** Location 変更通知のパラメータ */
export interface LocationChangeParams {
  /** ユーザーの表示名 */
  displayName: string
  /** ユーザー ID */
  userId: string
  /** 前回の Location */
  previousLocation: string | null
  /** 現在の Location */
  currentLocation: string
  /** ワールド名 */
  worldName?: string
  /** サムネイル URL */
  thumbnailUrl?: string
}

/** オンライン通知のパラメータ */
export interface OnlineParams {
  /** ユーザーの表示名 */
  displayName: string
  /** ユーザー ID */
  userId: string
}

/** オフライン通知のパラメータ */
export interface OfflineParams {
  /** ユーザーの表示名 */
  displayName: string
  /** ユーザー ID */
  userId: string
}

/** Embed の色 */
const COLORS = {
  /** Location 変更（青） */
  locationChange: 0x00_aa_ff,
  /** オンライン（緑） */
  online: 0x00_ff_00,
  /** オフライン（グレー） */
  offline: 0x80_80_80,
} as const

/**
 * Discord 通知を送信するクラス
 */
export class DiscordNotifier {
  private discord: Discord

  /**
   * DiscordNotifier を初期化する
   *
   * @param config アプリケーション設定
   */
  constructor(config: Config) {
    this.discord = new Discord({
      webhookUrl: config.discord.webhookUrl,
    })
  }

  /**
   * Location 変更通知を送信する
   *
   * @param params 通知パラメータ
   */
  async notifyLocationChange(params: LocationChangeParams): Promise<void> {
    const embed: DiscordEmbed = {
      title: '\u{1F4CD} ロケーション変更',
      color: COLORS.locationChange,
      fields: [
        {
          name: 'ユーザー',
          value: params.displayName,
          inline: true,
        },
        {
          name: '前の場所',
          value: params.previousLocation ?? 'N/A',
          inline: true,
        },
        {
          name: '現在の場所',
          value: params.currentLocation,
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
    }

    // ワールド名がある場合は追加
    if (params.worldName) {
      embed.fields?.push({
        name: 'ワールド',
        value: params.worldName,
        inline: false,
      })
    }

    // サムネイルがある場合は追加
    if (params.thumbnailUrl) {
      embed.thumbnail = {
        url: params.thumbnailUrl,
      }
    }

    await this.sendEmbed(embed)
  }

  /**
   * オンライン通知を送信する
   *
   * @param params 通知パラメータ
   */
  async notifyOnline(params: OnlineParams): Promise<void> {
    const embed: DiscordEmbed = {
      title: '\u{1F7E2} オンライン',
      color: COLORS.online,
      fields: [
        {
          name: 'ユーザー',
          value: params.displayName,
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
    }

    await this.sendEmbed(embed)
  }

  /**
   * オフライン通知を送信する
   *
   * @param params 通知パラメータ
   */
  async notifyOffline(params: OfflineParams): Promise<void> {
    const embed: DiscordEmbed = {
      title: '\u{26AB} オフライン',
      color: COLORS.offline,
      fields: [
        {
          name: 'ユーザー',
          value: params.displayName,
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
    }

    await this.sendEmbed(embed)
  }

  /**
   * Embed を送信する
   *
   * @param embed Discord Embed
   */
  private async sendEmbed(embed: DiscordEmbed): Promise<void> {
    try {
      await this.discord.sendMessage({
        embeds: [embed],
      })
    } catch (error) {
      // Discord 通知の失敗は致命的ではないため、ログ出力のみ
      console.error('[DISCORD] Failed to send notification:', error)
    }
  }
}
