import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ChannelType,
  PermissionFlagsBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  type Guild,
} from "discord.js";
import { logger } from "./lib/logger";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── Slash commands definition ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ouvre le panneau de tickets"),

  new SlashCommandBuilder()
    .setName("pricing")
    .setDescription("Affiche les informations de prix"),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Lance un giveaway")
    .addStringOption((opt) =>
      opt.setName("duree").setDescription("Durée du giveaway (ex: 21h, 1d, 30m)").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName("gagnants").setDescription("Nombre de gagnants").setRequired(true).setMinValue(1)
    )
    .addStringOption((opt) =>
      opt.setName("prix").setDescription("Ce que le gagnant remporte").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("dm-all")
    .setDescription("Envoie un DM à tous les membres du serveur (Admin seulement)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Le message à envoyer en DM").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setlogs")
    .setDescription("Définit le salon de logs du serveur (Admin seulement)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt.setName("salon").setDescription("Le salon où envoyer les logs").setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

// ─── Logs storage ────────────────────────────────────────────────────────────

const logChannels = new Map<string, string>(); // guildId -> channelId

async function sendLog(guildId: string, embed: EmbedBuilder): Promise<void> {
  const channelId = logChannels.get(guildId);
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => {});
}

// ─── Giveaway storage ────────────────────────────────────────────────────────

interface Giveaway {
  messageId: string;
  channelId: string;
  guildId: string;
  prize: string;
  winnersCount: number;
  endsAt: Date;
  creatorId: string;
  creatorTag: string;
  participants: Set<string>;
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const giveaways = new Map<string, Giveaway>();

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(d|h|m)$/i);
  if (!match) return null;
  const value = parseInt(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "m") return value * 60 * 1000;
  return null;
}

function buildGiveawayEmbed(giveaway: Giveaway, guild: Guild): EmbedBuilder {
  const iconUrl = guild.iconURL({ size: 256 }) ?? null;
  const endTimestamp = Math.floor(giveaway.endsAt.getTime() / 1000);

  return new EmbedBuilder()
    .setTitle("🎉 GIVEAWAY")
    .setColor(0x5865f2)
    .setThumbnail(iconUrl)
    .setDescription(
      `**Prix:**\n> ${giveaway.prize}\n\n` +
      `**Gagnants:** ${giveaway.winnersCount}\n` +
      `**Participants:** ${giveaway.participants.size}\n` +
      `**Se termine:** <t:${endTimestamp}:R>\n\n` +
      `Clique sur le bouton ci-dessous !`
    )
    .setFooter({ text: `Créé par ${giveaway.creatorTag}` })
    .setTimestamp(giveaway.endsAt);
}

function buildGiveawayButtons(ended: boolean): ActionRowBuilder<ButtonBuilder> {
  const joinBtn = new ButtonBuilder()
    .setCustomId("giveaway_join")
    .setLabel("Participer")
    .setEmoji("🎉")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(ended);

  const viewBtn = new ButtonBuilder()
    .setCustomId("giveaway_view")
    .setLabel("Voir participants")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(joinBtn, viewBtn);
}

async function endGiveaway(messageId: string): Promise<void> {
  const giveaway = giveaways.get(messageId);
  if (!giveaway || giveaway.ended) return;
  giveaway.ended = true;

  const channel = client.channels.cache.get(giveaway.channelId) as TextChannel | undefined;
  if (!channel) return;
  const guild = client.guilds.cache.get(giveaway.guildId);
  if (!guild) return;

  const participantsList = [...giveaway.participants];
  let resultText = "Aucun participant — pas de gagnant.";
  const winnerMentions: string[] = [];

  if (participantsList.length > 0) {
    const pool = [...participantsList];
    const count = Math.min(giveaway.winnersCount, pool.length);
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      winnerMentions.push(pool.splice(idx, 1)[0]!);
    }
    resultText = `🏆 Gagnant${winnerMentions.length > 1 ? "s" : ""} : ${winnerMentions.map((id) => `<@${id}>`).join(", ")}`;
  }

  const endedEmbed = new EmbedBuilder()
    .setTitle("🎉 GIVEAWAY — TERMINÉ")
    .setColor(0xed4245)
    .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
    .setDescription(
      `**Prix:**\n> ${giveaway.prize}\n\n` +
      `**Participants:** ${giveaway.participants.size}\n` +
      `**Se termine:** Terminé\n\n` +
      resultText
    )
    .setFooter({ text: `Créé par ${giveaway.creatorTag}` })
    .setTimestamp();

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [endedEmbed], components: [buildGiveawayButtons(true)] });

  if (winnerMentions.length > 0) {
    await channel.send(
      `🎊 Félicitations ${winnerMentions.map((id) => `<@${id}>`).join(", ")} ! Vous avez gagné **${giveaway.prize}** !`
    );
  } else {
    await channel.send(`Le giveaway pour **${giveaway.prize}** est terminé — aucun participant.`);
  }
}

// ─── Register slash commands on ready ────────────────────────────────────────

async function registerSlashCommands(clientId: string, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info("Commandes slash enregistrées avec succès");
  } catch (err) {
    logger.error({ err }, "Erreur lors de l'enregistrement des commandes slash");
  }
}

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  logger.info({ tag: readyClient.user.tag }, "Bot Discord connecté");
  const token = process.env["DISCORD_TOKEN"]!;
  await registerSlashCommands(readyClient.user.id, token);
});

// ─── Slash command handler ─────────────────────────────────────────────────

async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;

  // /pricing
  if (interaction.commandName === "pricing") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setDescription(
        "• Prices:\n\n" +
        "**FORPERMANENT KEY**\n\n" +
        "• 9,00$ **`PAYPAL`** [@Click here](https://www.paypal.com/paypalme/27Ontop)\n" +
        "• 10$ **`GIFTCARD robux & paysafcard`**\n" +
        "• Brainrot | Minimum Garama 2 Traits\n\n" +
        "Make a ticket for buy <#1476335856599040062>"
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.SuppressEmbeds });
    return;
  }

  // /ticket
  if (interaction.commandName === "ticket") {
    const embed = new EmbedBuilder()
      .setTitle("🎫 Système de Tickets")
      .setDescription(
        "• 💰 **PRIX → 8€ Lifetime**\n\n" +
        "• ✨ **CE QUE TU OBTIENS**\n" +
        "✓ Accès à vie au script\n" +
        "✓ Toutes les mises à jour incluses\n" +
        "✓ Accès aux salons privés\n\n" +
        "• 💳 **MOYEN DE PAIEMENT**\n" +
        "• PayPal : <@1415293957272895691> ou <@1462090089294201045>\n" +
        "• Brainrots : (Minimum 2 Garama)\n\n" +
        "Sélectionne une catégorie ci-dessous pour ouvrir un ticket."
      )
      .setColor(0x5865f2);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("ticket_category")
      .setPlaceholder("Choisis une catégorie")
      .addOptions([
        { label: "BUY", value: "buy", emoji: "🪓" },
        { label: "HELP", value: "help", emoji: "❓" },
      ]);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

  // /dm-all
  if (interaction.commandName === "dm-all") {
    if (!guild) return;

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser cette commande.", ephemeral: true });
      return;
    }

    const message = interaction.options.getString("message", true);
    await interaction.deferReply({ ephemeral: true });

    try {
      await guild.members.fetch();
    } catch {}

    const members = guild.members.cache.filter((m) => !m.user.bot);
    let sent = 0;
    let failed = 0;

    for (const [, m] of members) {
      try {
        await m.send(message);
        sent++;
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        failed++;
      }
    }

    await interaction.editReply(
      `✅ DM envoyé à **${sent}** membres. ❌ Échec pour **${failed}** membres (DMs désactivés).`
    );
    return;
  }

  // /setlogs
  if (interaction.commandName === "setlogs") {
    if (!guild) return;
    const channel = interaction.options.getChannel("salon", true);
    logChannels.set(guild.id, channel.id);
    await interaction.reply({
      content: `✅ Salon de logs défini sur <#${channel.id}> !`,
      ephemeral: true,
    });
    await sendLog(guild.id, new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("📋 Logs activés")
      .setDescription(`Les logs du serveur seront envoyés ici.`)
      .setTimestamp()
    );
    return;
  }

  // /giveaway
  if (interaction.commandName === "giveaway") {
    if (!guild) return;

    const durationStr = interaction.options.getString("duree", true);
    const winnersCount = interaction.options.getInteger("gagnants", true);
    const prize = interaction.options.getString("prix", true);

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
      await interaction.reply({ content: "❌ Durée invalide. Exemples : `21h`, `1d`, `30m`", ephemeral: true });
      return;
    }

    const endsAt = new Date(Date.now() + durationMs);
    const placeholderGiveaway: Giveaway = {
      messageId: "",
      channelId: interaction.channelId,
      guildId: guild.id,
      prize,
      winnersCount,
      endsAt,
      creatorId: interaction.user.id,
      creatorTag: interaction.user.tag,
      participants: new Set(),
      ended: false,
      timer: setTimeout(() => {}, 0),
    };

    const embed = buildGiveawayEmbed(placeholderGiveaway, guild);
    const row = buildGiveawayButtons(false);

    await interaction.reply({ embeds: [embed], components: [row] });
    const sent = await interaction.fetchReply();

    const timer = setTimeout(() => endGiveaway(sent.id), durationMs);
    giveaways.set(sent.id, { ...placeholderGiveaway, messageId: sent.id, timer });
    logger.info({ messageId: sent.id, prize, durationMs }, "Giveaway créé");
    return;
  }
}

// ─── Global error handler (prevent crashes) ───────────────────────────────────

client.on("error", (err) => {
  logger.error({ err }, "Erreur Discord client");
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {

  // Slash commands
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction as ChatInputCommandInteraction);
    return;
  }

  // Ticket — select menu
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_category") {
    const menuInteraction = interaction as StringSelectMenuInteraction;
    const category = menuInteraction.values[0];
    const guild = menuInteraction.guild;
    const user = menuInteraction.user;
    if (!guild) return;

    const categoryLabel = category === "buy" ? "BUY" : "HELP";
    const channelName = `ticket-${categoryLabel.toLowerCase()}-${user.username}`.slice(0, 100);

    const existing = guild.channels.cache.find(
      (ch) => ch.name === channelName && ch.type === ChannelType.GuildText,
    );

    if (existing) {
      await menuInteraction.reply({ content: `Tu as déjà un ticket ouvert : <#${existing.id}>`, ephemeral: true });
      return;
    }

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
      ],
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🎫 Ticket — ${categoryLabel}`)
      .setDescription(`Bonjour <@${user.id}>, merci d'avoir ouvert un ticket **${categoryLabel}**.\n\nUn membre du staff va te répondre dès que possible.`)
      .setColor(category === "buy" ? 0x57f287 : 0xfee75c)
      .setFooter({ text: "Clique sur le bouton ci-dessous pour fermer le ticket." });

    const closeBtn = new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("🔒 Fermer le ticket")
      .setStyle(ButtonStyle.Danger);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn);

    await (ticketChannel as TextChannel).send({
      content: `<@${user.id}>`,
      embeds: [welcomeEmbed],
      components: [buttonRow],
    });

    await menuInteraction.reply({ content: `✅ Ton ticket a été créé : <#${ticketChannel.id}>`, ephemeral: true });
    return;
  }

  // Ticket — close button
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    const btn = interaction as ButtonInteraction;
    const channel = btn.channel as TextChannel;
    await btn.reply({ content: "🔒 Fermeture du ticket dans 5 secondes..." });
    setTimeout(() => channel.delete().catch(() => {}), 5000);
    return;
  }

  // Giveaway — join button
  if (interaction.isButton() && interaction.customId === "giveaway_join") {
    const btn = interaction as ButtonInteraction;
    const giveaway = giveaways.get(btn.message.id);
    if (!giveaway || giveaway.ended) {
      await btn.reply({ content: "Ce giveaway est terminé.", ephemeral: true });
      return;
    }
    const guild = btn.guild;
    if (!guild) return;

    if (giveaway.participants.has(btn.user.id)) {
      giveaway.participants.delete(btn.user.id);
      await btn.reply({ content: "❌ Tu t'es retiré du giveaway.", ephemeral: true });
    } else {
      giveaway.participants.add(btn.user.id);
      await btn.reply({ content: "✅ Tu participes au giveaway ! Bonne chance 🎉", ephemeral: true });
    }

    const updatedEmbed = buildGiveawayEmbed(giveaway, guild);
    await btn.message.edit({ embeds: [updatedEmbed], components: [buildGiveawayButtons(false)] });
    return;
  }

  // Giveaway — view participants button
  if (interaction.isButton() && interaction.customId === "giveaway_view") {
    const btn = interaction as ButtonInteraction;
    const giveaway = giveaways.get(btn.message.id);
    if (!giveaway) {
      await btn.reply({ content: "Giveaway introuvable.", ephemeral: true });
      return;
    }
    if (giveaway.participants.size === 0) {
      await btn.reply({ content: "Aucun participant pour l'instant.", ephemeral: true });
      return;
    }
    const list = [...giveaway.participants].map((id) => `<@${id}>`).join(", ");
    const text = `**Participants (${giveaway.participants.size}) :**\n${list}`;
    await btn.reply({ content: text.length > 2000 ? text.slice(0, 1997) + "..." : text, ephemeral: true });
    return;
  }

  } catch (err) {
    logger.error({ err }, "Erreur interaction");
  }
});

// ─── Événements de logs ───────────────────────────────────────────────────────

// Membre rejoint
client.on(Events.GuildMemberAdd, async (member) => {
  await sendLog(member.guild.id, new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("📥 Membre rejoint")
    .setDescription(`<@${member.id}> **${member.user.tag}**`)
    .addFields({ name: "ID", value: member.id, inline: true })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp()
  );
});

// Membre parti
client.on(Events.GuildMemberRemove, async (member) => {
  await sendLog(member.guild.id, new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("📤 Membre parti")
    .setDescription(`**${member.user.tag}**`)
    .addFields({ name: "ID", value: member.id, inline: true })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp()
  );
});

// Message supprimé
client.on(Events.MessageDelete, async (message) => {
  if (!message.guild || message.author?.bot) return;
  await sendLog(message.guild.id, new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🗑️ Message supprimé")
    .setDescription(`**Auteur :** <@${message.author?.id}> dans <#${message.channelId}>`)
    .addFields({ name: "Contenu", value: message.content?.slice(0, 1024) || "*Inconnu*" })
    .setTimestamp()
  );
});

// Message modifié
client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  await sendLog(newMsg.guild.id, new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("✏️ Message modifié")
    .setDescription(`**Auteur :** <@${newMsg.author?.id}> dans <#${newMsg.channelId}>`)
    .addFields(
      { name: "Avant", value: oldMsg.content?.slice(0, 512) || "*Inconnu*" },
      { name: "Après", value: newMsg.content?.slice(0, 512) || "*Inconnu*" }
    )
    .setTimestamp()
  );
});

// Membre banni
client.on(Events.GuildBanAdd, async (ban) => {
  await sendLog(ban.guild.id, new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔨 Membre banni")
    .setDescription(`**${ban.user.tag}** a été banni`)
    .addFields(
      { name: "ID", value: ban.user.id, inline: true },
      { name: "Raison", value: ban.reason ?? "Aucune raison", inline: true }
    )
    .setTimestamp()
  );
});

// Membre débanni
client.on(Events.GuildBanRemove, async (ban) => {
  await sendLog(ban.guild.id, new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Membre débanni")
    .setDescription(`**${ban.user.tag}** a été débanni`)
    .addFields({ name: "ID", value: ban.user.id, inline: true })
    .setTimestamp()
  );
});

// ─── Protection serveur ───────────────────────────────────────────────────────

const LINK_REGEX = /(https?:\/\/|discord\.gg\/|www\.)[^\s]+/gi;
const INVITE_REGEX = /(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/[^\s]+/gi;

// Anti-spam : compteur de messages par user
const spamMap = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();

function isStaff(member: import("discord.js").GuildMember): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  const member = message.member;
  if (!member) return;
  if (isStaff(member)) return;

  const content = message.content;
  let deleted = false;
  let reason = "";

  // Anti-@everyone / @here
  if (/@everyone|@here/.test(content)) {
    await message.delete().catch(() => {});
    deleted = true;
    reason = "@everyone / @here interdit";
  }

  // Anti-lien & anti-invite
  if (!deleted) {
    LINK_REGEX.lastIndex = 0;
    INVITE_REGEX.lastIndex = 0;
    if (LINK_REGEX.test(content) || INVITE_REGEX.test(content)) {
      await message.delete().catch(() => {});
      deleted = true;
      reason = "lien/invitation interdit";
    }
  }

  // Anti-spam (5 messages en 5 secondes)
  if (!deleted) {
    const key = `${message.guild.id}-${message.author.id}`;
    const entry = spamMap.get(key) ?? { count: 0, timer: setTimeout(() => {}, 0) };
    entry.count++;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => spamMap.delete(key), 5000);
    spamMap.set(key, entry);

    if (entry.count >= 5) {
      await message.delete().catch(() => {});
      deleted = true;
      reason = "spam détecté";
      spamMap.delete(key);
      // Timeout 30 secondes
      await member.timeout(30_000, "Spam").catch(() => {});
    }
  }

  // Anti-majuscules excessives (>70% caps sur +10 chars)
  if (!deleted && content.length > 10) {
    const upper = content.replace(/[^A-Z]/g, "").length;
    const letters = content.replace(/[^a-zA-Z]/g, "").length;
    if (letters > 0 && upper / letters > 0.7) {
      await message.delete().catch(() => {});
      deleted = true;
      reason = "trop de majuscules";
    }
  }

  if (deleted) {
    const warn = await message.channel.send(
      `🚫 <@${message.author.id}> — message supprimé (**${reason}**).`
    ).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.error("DISCORD_TOKEN manquant — le bot Discord ne démarrera pas");
    return;
  }
  // Sur Replit (dev), on ne connecte pas le bot pour éviter le conflit avec Railway
  const isRailway = !!process.env["RAILWAY_ENVIRONMENT"] || !!process.env["RAILWAY_SERVICE_ID"];
  const forceStart = !!process.env["FORCE_BOT_START"];
  if (!isRailway && !forceStart) {
    logger.info("Environnement local détecté — bot Discord désactivé (Railway gère la prod)");
    return;
  }
  client.login(token).catch((err) => {
    logger.error({ err }, "Échec de connexion du bot Discord");
  });
}

export default client;
